import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import {
  CONSUMER_MCP_URL,
  QUALIFICATION_LIMITS,
  createConsumerCharacter,
  createConsumerElement,
  listConsumerCharacters,
  listConsumerElements,
} from "../../lib/higgsfield-consumer/mcp";
import { checkTool, toolsetFrom } from "../../lib/higgsfield-consumer/toolset";
import { parseElementCreate } from "../../lib/higgsfield-consumer/element-parse";
import { accountCreatedAt, matchBuild, BUILD_MATCH_WINDOW } from "../../lib/higgsfield-consumer/build-records";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-builds-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.ENGINE_MOCK = "1";

type Tool = { name: string; inputSchema: Record<string, unknown> };
const recorded = JSON.parse(readFileSync("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: Tool[] };
const stills = Array.from({ length: 5 }, (_, i) => ({ url: `https://fixtures.particl.invalid/uploads/still-${i}.png`, type: "image" as const }));
type Packet = { id: string; method: string; params: { name: string; arguments: Record<string, unknown> } };
/** A connected account speaking the recorded 98-tool surface. Every token is fresh, so no cached toolset leaks between cases. */
function account(reply: (p: Packet) => unknown = () => undefined) {
  const calls: Packet[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(CONSUMER_MCP_URL);
    const p = JSON.parse(String(init?.body)) as Packet;
    calls.push(p);
    if (p.method === "initialize")
      return Response.json({ jsonrpc: "2.0", id: p.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    if (p.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (p.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: p.id, result: { tools: recorded.tools } });
    const changed = reply(p);
    if (changed instanceof Error) throw changed;
    const value = changed ?? (p.params.name === "media_import_url" ? { media_id: randomUUID(), type: "image" } : { ok: true });
    return Response.json({ jsonrpc: "2.0", id: p.id, result: { structuredContent: value } });
  };
  const named = (name: string) => calls.filter((p) => p.method === "tools/call" && p.params.name === name);
  return { fetch: fetcher, named, token: `fixture-${randomUUID()}` };
}
const creates = (a: ReturnType<typeof account>, tool: string) => a.named(tool).filter((p) => p.params.arguments.action === "create");

test("a reference element create carries the {id, url} media pair the recorded schema requires", async () => {
  const imported = randomUUID();
  const a = account((p) => (p.params.name === "media_import_url" ? { media_id: imported, type: "image", url: "https://cdn.example.com/imported.png" }
    : p.params.arguments.action === "create" ? { element_id: "el_fox", name: "Fox", category: "character" } : undefined));
  let admitted = 0;
  const result = await createConsumerElement(a.token, { name: "Fox", category: "character", description: "A red fox" }, stills.slice(0, 1), { fetch: a.fetch, admit: async () => { admitted++; } });
  expect(result).toEqual({ state: "accepted", value: { element_id: "el_fox", name: "Fox", category: "character" } });
  expect(admitted).toBe(1);
  const [create] = creates(a, "show_reference_elements");
  expect(create.params.arguments).toEqual({ action: "create", name: "Fox", category: "character", description: "A red fox", medias: [{ id: imported, type: "media_input", url: "https://cdn.example.com/imported.png" }] });
  // The same arguments pass the advertised schema; the old id-only shape did not.
  const toolset = toolsetFrom(recorded.tools);
  expect(checkTool(toolset, "show_reference_elements", create.params.arguments)).toBe("ok");
  expect(checkTool(toolset, "show_reference_elements", { ...create.params.arguments, medias: [{ id: imported, type: "media_input" }] })).toBe("mismatch");
  // An import that names no URL falls back to the source it was imported from.
  const b = account((p) => (p.params.name === "media_import_url" ? { media_id: imported } : undefined));
  await createConsumerElement(b.token, { name: "Fox", category: "character", description: "" }, stills.slice(0, 1), { fetch: b.fetch, admit: async () => {} });
  expect((creates(b, "show_reference_elements")[0].params.arguments.medias as unknown[])[0]).toEqual({ id: imported, type: "media_input", url: stills[0].url });
});

test("a create whose answer is lost after it was sent is uncertain, never 'nothing was sent'; a refused admission sends nothing", async () => {
  const lost = account((p) => (p.params.arguments?.action === "create" ? new Error("socket closed") : undefined));
  expect(await createConsumerCharacter(lost.token, { name: "Mira", type: "soul_2" }, stills, { fetch: lost.fetch, admit: async () => {} })).toEqual({ state: "uncertain" });
  expect(creates(lost, "show_characters")).toHaveLength(1);
  const lostElement = account((p) => (p.params.arguments?.action === "create" ? new Error("socket closed") : undefined));
  expect(await createConsumerElement(lostElement.token, { name: "Fox", category: "prop", description: "" }, stills.slice(0, 1), { fetch: lostElement.fetch, admit: async () => {} })).toEqual({ state: "uncertain" });
  // The durable claim refused (the same build is already open): nothing paid goes out, and the caller's error arrives unchanged.
  const refused = account();
  const claimError = new Error("already open");
  await expect(createConsumerCharacter(refused.token, { name: "Mira", type: "soul_2" }, stills, { fetch: refused.fetch, admit: async () => { throw claimError; } })).rejects.toBe(claimError);
  expect(creates(refused, "show_characters")).toHaveLength(0);
  // A failure before the create (an import) is still "nothing was sent".
  const early = account((p) => (p.params.name === "media_import_url" ? new Error("import down") : undefined));
  await expect(createConsumerCharacter(early.token, { name: "Mira", type: "soul_2" }, stills, { fetch: early.fetch, admit: async () => {} })).rejects.toMatchObject({ code: "preflight_unavailable" });
  expect(creates(early, "show_characters")).toHaveLength(0);
  // Creates carry twenty stills and get a longer per-call limit than a submission.
  expect(QUALIFICATION_LIMITS.createCallTimeoutMs).toBeGreaterThan(QUALIFICATION_LIMITS.callTimeoutMs);
});

test("the libraries are read past the first page until every recorded id is found, and elements are fetched by id when still missing", async () => {
  const page = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ soul_id: `soul_${from + i}`, name: `n${from + i}` }));
  const characters = account((p) => {
    if (p.params.name !== "show_characters") return undefined;
    const cursor = p.params.arguments.cursor;
    return cursor === undefined ? { items: page(0, 100), next_cursor: 100 } : cursor === 100 ? { items: page(100, 100), next_cursor: 200 } : { items: page(200, 5), next_cursor: null };
  });
  const read = await listConsumerCharacters(characters.token, new Set(["soul_150"]), { fetch: characters.fetch });
  expect(read.state).toBe("ok");
  expect(characters.named("show_characters").map((p) => p.params.arguments)).toEqual([{ action: "list", size: 100 }, { action: "list", size: 100, cursor: 100 }]);
  expect(((read as { value: { items: { soul_id: string }[] } }).value.items).some((e) => e.soul_id === "soul_150")).toBe(true);
  // A reply that names no next page stops the read.
  const single = account((p) => (p.params.name === "show_characters" ? { items: page(0, 3) } : undefined));
  await listConsumerCharacters(single.token, new Set(["soul_900"]), { fetch: single.fetch });
  expect(single.named("show_characters")).toHaveLength(1);
  const elements = account((p) => {
    if (p.params.name !== "show_reference_elements") return undefined;
    if (p.params.arguments.action === "get") return p.params.arguments.element_id === "el_old" ? { element_id: "el_old", name: "Harbour", category: "environment" } : { error: "not found" };
    return { items: [{ element_id: "el_new", name: "Fox" }] };
  });
  const listed = await listConsumerElements(elements.token, { fetch: elements.fetch }, new Set(["el_new", "el_old"]));
  expect(elements.named("show_reference_elements").map((p) => p.params.arguments)).toEqual([{ action: "list", size: 100 }, { action: "get", element_id: "el_old" }]);
  expect(((listed as { value: { items: { element_id: string }[] } }).value.items).map((e) => e.element_id)).toEqual(["el_new", "el_old"]);
});

test("a create reply that is a list is the new element only when it holds exactly one entry with the requested name", () => {
  expect(parseElementCreate({ element_id: "el_1", name: "Fox" }, "Fox", "character")).toMatchObject({ elementId: "el_1" });
  expect(parseElementCreate({ items: [{ element_id: "el_1", name: "Fox" }] }, "Fox", "character")).toMatchObject({ elementId: "el_1" });
  expect(parseElementCreate({ items: [{ element_id: "el_site", name: "Harbour" }] }, "Fox", "character")).toBeNull();
  expect(parseElementCreate({ items: [{ element_id: "el_site", name: "Harbour" }, { element_id: "el_1", name: "Fox" }] }, "Fox", "character")).toBeNull();
});

test("an accepted build without an id is matched only to one unrecorded entry of the same name and type made just after it was sent", () => {
  const sent = Date.parse("2026-09-25T10:00:00Z");
  const build = { name: "Mira", type: "soul_2", createdAt: sent };
  const at = (minutes: number) => sent + minutes * 60_000;
  expect(accountCreatedAt({ created_at: "2026-09-25T10:03:00Z" })).toBe(at(3));
  expect(accountCreatedAt({ createdAt: Math.floor(at(3) / 1000) })).toBe(at(3));
  expect(accountCreatedAt({ created: at(3) })).toBe(at(3));
  expect(accountCreatedAt({ name: "no time" })).toBeNull();
  expect(matchBuild(build, [{ id: "soul_new", name: "Mira", type: "soul_2", createdAt: at(3) }])).toBe("soul_new");
  // The owner's own identity with the same name, made before the send, is never adopted.
  expect(matchBuild(build, [{ id: "soul_site", name: "Mira", type: "soul_2", createdAt: at(-60) }])).toBeNull();
  expect(matchBuild(build, [{ id: "soul_late", name: "Mira", type: "soul_2", createdAt: sent + BUILD_MATCH_WINDOW.afterMs + 1 }])).toBeNull();
  expect(matchBuild(build, [{ id: "soul_x", name: "Mira", type: "soul_cinematic", createdAt: at(3) }])).toBeNull();
  expect(matchBuild(build, [{ id: "soul_x", name: "Mira", type: "soul_2", createdAt: null }])).toBeNull();
  // Two candidates: no guess.
  expect(matchBuild(build, [{ id: "a", name: "Mira", type: "soul_2", createdAt: at(2) }, { id: "b", name: "Mira", type: null, createdAt: at(4) }])).toBeNull();
});

let sequence = 0;
function workspace(): TenantWorkspace {
  const name = `builds-${++sequence}`;
  return {
    id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(directory, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: false,
    allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
    concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
  };
}
test("a build is claimed durably before it is sent; the same build is refused while it may be on the account, and freed once refused or never sent", async () => {
  const records = await import("../../lib/higgsfield-consumer/build-records");
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  await tenant.runInTenant(workspace(), async () => {
    const identity = { userId: "owner", kind: "character" as const, fingerprint: records.buildFingerprint("character", "Mira", "soul_2", [{ uploadId: "a" }]) };
    const claim = { ...identity, projectId: "ws-1", name: "Mira", type: "soul_2" };
    const first = await records.claimBuild(claim);
    await expect(records.claimBuild(claim)).rejects.toMatchObject({ code: "build_in_flight", status: 409 });
    await expect(records.assertNoOpenBuild(identity)).rejects.toBeInstanceOf(records.BuildInFlightError);
    // Another owner, or another request, is not blocked.
    await records.assertNoOpenBuild({ ...identity, userId: "someone-else" });
    await records.assertNoOpenBuild({ ...identity, fingerprint: records.buildFingerprint("character", "Mira", "soul_2", [{ uploadId: "b" }]) });
    await records.settleBuild(first, "uncertain");
    await expect(records.claimBuild(claim)).rejects.toMatchObject({ code: "build_in_flight" });
    expect((await records.openBuilds("character", "owner")).map((b) => [b.name, b.state, b.stale])).toEqual([["Mira", "uncertain", false]]);
    expect(await records.openBuilds("character", "someone-else")).toEqual([]);
    // A day later the account never named it: closed as unmatched (kept), and the request may be sent again.
    await database.db().execute({ sql: "UPDATE higgsfield_consumer_builds SET created_at=? WHERE id=?", args: [Date.now() - records.BUILD_MATCH_GIVE_UP_MS - 1, first] });
    expect((await records.openBuilds("character", "owner"))[0].stale).toBe(true);
    const second = await records.claimBuild(claim);
    await records.settleBuild(second, "refused");
    const third = await records.claimBuild(claim);
    await records.settleBuild(third, "not_sent");
    await records.claimBuild(claim);
    const rows = (await database.db().execute("SELECT state FROM higgsfield_consumer_builds ORDER BY created_at")).rows.map((row) => String(row.state));
    expect(rows.sort()).toEqual(["not_sent", "refused", "sending", "unmatched"]);
  });
});
