import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import type { TenantWorkspace } from "../../lib/tenant";
import type { ProductFetchDependencies } from "../../lib/workbench/product-fetch";
import { parseConsumerVideoInput } from "../../lib/higgsfield-consumer/video-contract";
import { resetConnectedToolsetCache } from "../../lib/higgsfield-consumer/toolset";
import type { ConsumerVoiceToolInput } from "../../lib/higgsfield-consumer/voice-tools";

/**
 * Collected connected-account originals record their length (the gap the live
 * qualification found on 20 September 2026).
 *
 * `gen_hfc_…` — a video generated on the connected account and collected into a
 * project — was stored with `generations.duration_s` NULL, because the collector
 * measured the length for its receipt and then never wrote the column. Every
 * tool that prices per second reads that column, so the reframe quote refused
 * the workspace's own video with "This video has no stored duration. Re-upload
 * it before reframing." — advice a collected original cannot follow.
 *
 * Two halves are asserted here:
 *   forward   — a collected video (and audio) persists the measured length, and
 *               a length that cannot be measured leaves the job settled exactly
 *               as before, with the column null.
 *   backfill  — an original already stored without a length is measured on first
 *               read and written back, so today's video is priceable without
 *               being re-generated or re-uploaded.
 *
 * No paid call: the provider is a fixture fetch and the engine is mocked.
 */
const directory = mkdtempSync(path.join(tmpdir(), "particl-collected-duration-"));
process.env.PLATFORM_DATABASE_URL = `file:${directory}/platform.db`;
process.env.KEYRING_SECRET ??= "collected-duration-unit-keyring-not-real";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const original = readFileSync("tests/fixtures/astra-source.mp4");
/** The fixture clip's real length, as `inspectConsumerVideoOriginal` reads it. */
const SECONDS = 1.5;
const sourceUrl = "https://media.example.com/original.mp4";
const saved: string[] = [];
test.beforeEach(() => resetConnectedToolsetCache());
test.afterAll(async () => {
  await Promise.all(
    saved.map((id) => unlink(path.join(process.cwd(), ".data/generations", `${id}.mp4`)).catch(() => {})),
  );
});

function workspace(): TenantWorkspace {
  const id = `collected-duration-${randomUUID()}`;
  return {
    id, slug: id, name: id, legacy: false, dbUrl: `file:${directory}/${id}.db`, dbToken: null, keys: {},
    usesPlatformKeys: false, allowanceUsd: null, ownerId: "owner", createdAt: 0, gatewayKeyId: null,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null,
    rendersPerHour: null, storageQuotaBytes: original.length * 8, deletedAt: null,
  };
}

/** The provider's public original, served once over the pinned fetch. */
function transport() {
  const request = ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    void url; void options;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = () => req;
    req.end = (() => {
      queueMicrotask(() => {
        const response = Readable.from([original]) as IncomingMessage;
        response.statusCode = 200;
        response.headers = { "content-type": "video/mp4" };
        callback(response);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as ProductFetchDependencies["https"];
  return { http: request, https: request, resolve: async () => [{ address: "93.184.216.34", family: 4 }] };
}

async function modules() {
  return {
    originals: await import("../../lib/higgsfield-consumer/video-original"),
    jobs: await import("../../lib/higgsfield-consumer/jobs"),
    database: await import("../../lib/db"),
    tenant: await import("../../lib/tenant"),
    sources: await import("../../lib/higgsfield-consumer/voice-tool-sources"),
    media: await import("../../lib/mediaSource.server"),
  };
}

/** An accepted marketing video job on a mapped production, ready to collect. */
async function accepted(m: Awaited<ReturnType<typeof modules>>) {
  await m.database.ready();
  const draftId = `draft-${randomUUID()}`, productionId = `project-${randomUUID()}`;
  await m.database.db().execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,'Fixture',0)", args: [productionId] });
  await m.database.db().execute({
    sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,'owner',?,'Fixture',?,1,0)",
    args: [draftId, draftId, JSON.stringify({ productionProjectId: productionId })],
  });
  const { job } = await m.jobs.createConsumerJob({
    userId: "owner", draftId, connectedOwnerId: "owner", connectionGeneration: randomUUID(),
    workflow: "marketing-video", idempotencyKey: randomUUID(),
    payload: { input: { ...parseConsumerVideoInput({ prompt: "A plain bottle.", duration: 15, resolution: "720p", aspectRatio: "16:9", generateAudio: true }) } },
    quoteCredits: 75, quoteExpiresAt: Date.now() + 60_000, originalAssetIds: [],
  });
  const scope = { id: job.id, userId: job.userId, draftId };
  const claim = await m.jobs.claimConsumerDispatch(scope);
  const result = (await m.jobs.markConsumerAccepted({ ...scope, claimToken: claim!.claimToken, providerJobId: randomUUID() }))!;
  saved.push(m.originals.consumerOriginalGenerationId(m.tenant.requireTenant().id, result.id));
  return { job: result, draftId };
}

test("a collected connected video records the length it was already measuring, so a per-second tool can price it", async () => {
  const m = await modules();
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    const collected = await m.originals.collectConsumerVideoOriginal(job, sourceUrl, { fetchDependencies: transport() });
    expect(collected).toMatchObject({ bytes: original.length, sha256: createHash("sha256").update(original).digest("hex"), seconds: SECONDS });
    const row = (await m.database.db().execute({ sql: "SELECT duration_s, bytes, kind, status FROM generations WHERE id=?", args: [collected.generationId] })).rows[0];
    // FAILS ON origin/main: duration_s is null, which is the whole bug.
    expect(Number(row.duration_s)).toBeCloseTo(SECONDS, 3);
    expect(row).toMatchObject({ kind: "video", status: "succeeded", bytes: original.length });
    // The stored column is what the per-second admissions read, with no measuring.
    const source = (await m.media.findStoredSource({ genId: collected.generationId }))!;
    expect(source.seconds).toBeCloseTo(SECONDS, 3);
  });
});

test("a length that cannot be measured leaves the job settled and the duration null, exactly as before the column existed", async () => {
  const m = await modules();
  // Audio bytes that pass the header sniff but carry no readable track: null, never a throw.
  expect(await m.originals.collectedDurationSeconds("audio", { mime: "audio/mpeg" }, Buffer.from(`ID3${"x".repeat(400)}`))).toBeNull();
  expect(await m.originals.collectedDurationSeconds("audio", { mime: "audio/wav" }, Buffer.alloc(0))).toBeNull();
  // A 3D or still original has no length at all, and is not measured.
  expect(await m.originals.collectedDurationSeconds("model", { mime: "model/gltf-binary" }, original)).toBeNull();
  expect(await m.originals.collectedDurationSeconds("image", { width: 8, height: 8, mime: "image/png" }, original)).toBeNull();
  // A measured length is rounded to milliseconds and never guessed from a bad value.
  expect(await m.originals.collectedDurationSeconds("video", { seconds: 1.50049, width: 8, height: 8 }, original)).toBe(1.5);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(await m.originals.collectedDurationSeconds("video", { seconds: bad }, original)).toBeNull();

  // The resume path, as an original collected before the column existed leaves
  // it: bytes already stored, recorded metadata with no measured length. The
  // job settles and the column stays null for the backfill to fill.
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    const first = await m.originals.collectConsumerVideoOriginal(job, sourceUrl, { fetchDependencies: transport() });
    await m.database.db().execute({ sql: "DELETE FROM generations WHERE id=?", args: [first.generationId] });
    await m.database.db().execute({
      sql: "UPDATE consumer_video_originals SET state='preparing', receipt_json=NULL, metadata_json=? WHERE job_id=?",
      args: [JSON.stringify({ width: 720, height: 1280 }), job.id],
    });
    // No fetch is offered: the stored bytes and the recorded metadata are reused.
    const resumed = await m.originals.collectConsumerVideoOriginal(job, sourceUrl, { fetchDependencies: transport() });
    expect(resumed.generationId).toBe(first.generationId);
    expect(resumed.seconds).toBeUndefined();
    const ledger = (await m.database.db().execute({ sql: "SELECT state, lease FROM consumer_video_originals WHERE job_id=?", args: [job.id] })).rows[0];
    expect(ledger).toMatchObject({ state: "stored", lease: null });
    const row = (await m.database.db().execute({ sql: "SELECT status, duration_s FROM generations WHERE id=?", args: [first.generationId] })).rows[0];
    expect(row.status).toBe("succeeded");
    expect(row.duration_s).toBeNull();
    // And the backfill still prices it, from the bytes themselves.
    expect((await m.media.resolveStoredDuration((await m.media.findStoredSource({ genId: first.generationId }))!)).seconds).toBeCloseTo(SECONDS, 3);
  });
});

test("resolveStoredDuration backfills a collected original that was stored without a length, and the column answers next time", async () => {
  const m = await modules();
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    const collected = await m.originals.collectConsumerVideoOriginal(job, sourceUrl, { fetchDependencies: transport() });
    // Exactly the row shape the live qualification left behind.
    await m.database.db().execute({ sql: "UPDATE generations SET duration_s=NULL WHERE id=?", args: [collected.generationId] });
    const source = (await m.media.findStoredSource({ genId: collected.generationId }))!;
    expect(source).toMatchObject({ kind: "generation", mediaKind: "video", ext: "mp4", seconds: null });
    const resolved = await m.media.resolveStoredDuration(source);
    expect(resolved.seconds).toBeCloseTo(SECONDS, 3);
    const persisted = (await m.database.db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [collected.generationId] })).rows[0];
    expect(Number(persisted.duration_s)).toBeCloseTo(SECONDS, 3);
    // Second read is a column read: the stored value is returned unchanged.
    expect((await m.media.resolveStoredDuration((await m.media.findStoredSource({ genId: collected.generationId }))!)).seconds).toBeCloseTo(SECONDS, 3);
  });
});

/* ── The live failure, end to end ────────────────────────────────────── */
const connectedTools98 = JSON.parse(readFileSync("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const reframeTool = JSON.parse(readFileSync("tests/fixtures/connected-reframe-tool.json", "utf8")) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
const wallet = randomUUID(), mediaId = randomUUID(), providerJobId = randomUUID();
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
/** The connected account as a fixture: priced with `get_cost`, never submitted. */
function provider() {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: [...reframeTool.tools, ...connectedTools98.tools.filter((t) => t.name !== "reframe")] } });
    const body = (p.params.arguments.params as Record<string, unknown> | undefined) ?? p.params.arguments;
    const value =
      p.params.name === "list_workspaces" ? { workspaces: [{ id: wallet, is_selected: true, credits: 500, name: "Fixture wallet" }] }
      : p.params.name === "media_import_url" ? { media_id: mediaId, type: "video" }
      : body.get_cost === true ? { cost: { credits: 18, credits_exact: 18 } }
      : { results: [{ id: providerJobId, model: "reframe", type: "video" }] };
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  return {
    fetch: fetcher,
    paid: () => calls.filter((p) => p.method === "tools/call" && p.params.name === "reframe" &&
      ((p.params.arguments.params as Record<string, unknown> | undefined) ?? p.params.arguments).get_cost !== true),
  };
}

test("a reframe quote on a collected connected video succeeds without a re-upload (mocked provider, no paid call)", async () => {
  const m = await modules();
  const { getConsumerVoiceToolQuote } = await import("../../lib/higgsfield-consumer/mcp");
  await m.tenant.runInTenant(workspace(), async () => {
    const { job } = await accepted(m);
    const collected = await m.originals.collectConsumerVideoOriginal(job, sourceUrl, { fetchDependencies: transport() });
    // The live row: a stored original with no recorded length.
    await m.database.db().execute({ sql: "UPDATE generations SET duration_s=NULL WHERE id=?", args: [collected.generationId] });
    const input: ConsumerVoiceToolInput = { tool: "reframe", source: { genId: collected.generationId }, aspectRatio: "9:16", resolution: "480p" };
    // FAILS ON origin/main: durationSeconds is absent, so the quote below
    // throws invalid_input, "This video has no stored duration."
    const source = await m.sources.resolveConsumerVoiceToolSource(input);
    expect(source.durationSeconds).toBeCloseTo(SECONDS, 3);
    const persisted = (await m.database.db().execute({ sql: "SELECT duration_s FROM generations WHERE id=?", args: [collected.generationId] })).rows[0];
    expect(Number(persisted.duration_s)).toBeCloseTo(SECONDS, 3);
    const f = provider();
    const quote = await getConsumerVoiceToolQuote("fixture-private-access", input, source, { fetch: f.fetch, resolveMedia: (_w, perform) => perform() });
    expect(quote).toMatchObject({
      credits: 18,
      priceSource: "get_cost",
      params: { medias: [{ role: "video", value: mediaId }], aspect_ratio: "9:16", duration_seconds: SECONDS, resolution: "480p" },
    });
    expect(f.paid()).toEqual([]);
  });
});
