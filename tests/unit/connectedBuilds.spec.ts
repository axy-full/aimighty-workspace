import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import ts from "typescript";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantWorkspace } from "../../lib/tenant";
import {
  CONSUMER_MCP_URL,
  QUALIFICATION_LIMITS,
  createConsumerCharacter,
  createConsumerElement,
  characterGetArgs,
  listConsumerCharacters,
  listConsumerElements,
} from "../../lib/higgsfield-consumer/mcp";
import { checkTool, toolsetFrom } from "../../lib/higgsfield-consumer/toolset";
import { parseElementCreate } from "../../lib/higgsfield-consumer/element-parse";
import { accountCreatedAt, matchBuild, pagingForOpenBuilds, BUILD_MATCH_WINDOW } from "../../lib/higgsfield-consumer/build-records";
import type * as Characters from "../../lib/higgsfield-consumer/characters";
import type * as Elements from "../../lib/higgsfield-consumer/elements";

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
  // A reply that names no next page stops the paging; a recorded Soul ID still
  // missing is then read by its soul_id, and kept only if the reply is that one.
  const single = account((p) => (p.params.name !== "show_characters" ? undefined
    : p.params.arguments.action === "get" ? (p.params.arguments.soul_id === "soul_900" ? { character: { soul_id: "soul_900", name: "Mira", status: "ready" } } : { items: page(0, 3) })
    : { items: page(0, 3) }));
  const beyond = await listConsumerCharacters(single.token, new Set(["soul_900", "soul_901"]), { fetch: single.fetch });
  expect(single.named("show_characters").map((p) => p.params.arguments)).toEqual([{ action: "list", size: 100 }, characterGetArgs("soul_900"), characterGetArgs("soul_901")]);
  const ids = ((beyond as { value: { items: { soul_id: string }[] } }).value.items).map((e) => e.soul_id);
  expect(ids).toContain("soul_900");
  expect(ids).not.toContain("soul_901");
  // The get passes the advertised show_characters schema (soul_id; action is a free string there).
  expect(checkTool(toolsetFrom(recorded.tools), "show_characters", characterGetArgs("soul_900"))).toBe("ok");
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

test("while a build waits to be named, the list is paged until it is matched or the pages reach entries older than its window", async () => {
  const sent = Date.now() - 5 * 60_000;
  const builds = [{ name: "Mira", type: "soul_2", createdAt: sent, stale: false }];
  const entry = (id: string, name: string, minutes: number) => ({ soul_id: id, name, type: "soul_2", created_at: new Date(sent + minutes * 60_000).toISOString() });
  const candidates = (entries: readonly unknown[]) => entries.map((e) => e as { soul_id: string; name: string; type: string; created_at: string })
    .map((e) => ({ id: e.soul_id, name: e.name, type: e.type, createdAt: accountCreatedAt(e) }));
  const more = pagingForOpenBuilds(builds, candidates)!;
  // Nothing waits (or only stale builds): no extra paging.
  expect(pagingForOpenBuilds([], candidates)).toBeUndefined();
  expect(pagingForOpenBuilds([{ ...builds[0], stale: true }], candidates)).toBeUndefined();
  // Newer entries only, no match yet: keep paging. A match, or entries older than the window: stop.
  expect(more([entry("a", "Other", 30), entry("b", "Else", 20)])).toBe(true);
  expect(more([entry("a", "Other", 30), entry("new", "Mira", 3)])).toBe(false);
  expect(more([entry("a", "Other", 30), entry("old", "Old", -60)])).toBe(false);
  // Through the reader: page two holds the build, so the read goes that far and no further.
  const pages = [[entry("p1", "Other", 40)], [entry("new", "Mira", 3)], [entry("p3", "Older", -90)]];
  const a = account((p) => {
    if (p.params.name !== "show_characters") return undefined;
    const cursor = Number(p.params.arguments.cursor ?? 0);
    return { items: pages[cursor], next_cursor: cursor + 1 < pages.length ? cursor + 1 : null };
  });
  const read = await listConsumerCharacters(a.token, new Set(), { fetch: a.fetch }, more);
  expect(a.named("show_characters").map((p) => p.params.arguments.cursor ?? 0)).toEqual([0, 1]);
  expect(((read as { value: { items: { soul_id: string }[] } }).value.items).map((e) => e.soul_id)).toEqual(["p1", "new"]);
  // With nothing recorded and nothing waiting, page one is the whole read.
  const b = account((p) => (p.params.name === "show_characters" ? { items: pages[0], next_cursor: 1 } : undefined));
  await listConsumerCharacters(b.token, new Set(), { fetch: b.fetch });
  expect(b.named("show_characters")).toHaveLength(1);
});

/** characters.ts and elements.ts with the account replaced: the real ledger,
 * records and parsers on a tenant database; the paid creates never leave. */
async function buildServices() {
  const tenant = await import("../../lib/tenant"), database = await import("../../lib/db"), oauth = await import("../../lib/higgsfield-consumer/oauth");
  const state = {
    mode: "created" as "created" | "pending" | "refused" | "uncertain" | "not_sent",
    creates: 0,
    list: [] as unknown[],
    reads: [] as { wanted: string[]; paging: boolean }[],
  };
  const create = (value: unknown) => async (_token: string, _input: unknown, _sources: unknown, options: { admit: () => Promise<void> }) => {
    await options.admit();
    state.creates++;
    if (state.mode === "not_sent") { state.creates--; throw new Error("Stopped before the create was sent"); }
    if (state.mode === "refused") return { state: "refused", reason: "Not on this plan." };
    if (state.mode === "uncertain") return { state: "uncertain" };
    return { state: "accepted", value: state.mode === "created" ? value : { ok: true } };
  };
  const listing = async (_token: string, a: unknown, b: unknown, more?: (entries: readonly unknown[]) => boolean) => {
    const wanted = (a instanceof Set ? a : b) as Set<string>;
    state.reads.push({ wanted: [...wanted], paging: Boolean(more) });
    return { state: "ok", value: { items: state.list } };
  };
  const deps: Record<string, unknown> = {
    "@/lib/tenant": tenant,
    "@/lib/db": database,
    "./oauth": { ConsumerOAuthError: oauth.ConsumerOAuthError, getConsumerAccess: async () => ({ accessToken: "fixture-private-access", generation: "g" }) },
    "./mcp": {
      CONNECTED_LIBRARY_GETS: 20, CONNECTED_LIBRARY_PAGES: 5,
      readConnectedPlannerReads: async () => [],
      createConsumerCharacter: create({ soul_id: "soul_made", name: "Mira", type: "soul_2", status: "training" }),
      createConsumerElement: create({ element_id: "el_made", name: "Harbour", category: "environment" }),
      listConsumerCharacters: listing,
      listConsumerElements: listing,
    },
    "./generation-sources": { resolveConsumerGenerationSources: async (input: { medias: unknown[] }) => input.medias.map((_, i) => ({ url: `https://fixtures.particl.invalid/still-${i}.png` })) },
    "./soul-build": await import("../../lib/higgsfield-consumer/soul-build"),
    "./element-parse": await import("../../lib/higgsfield-consumer/element-parse"),
    "./character-records": await import("../../lib/higgsfield-consumer/character-records"),
    "./build-records": await import("../../lib/higgsfield-consumer/build-records"),
  };
  const load = <T,>(file: string) => {
    const loaded = { exports: {} as T };
    const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", source)((name: string) => { if (!(name in deps)) throw new Error(`Unexpected dependency: ${name}`); return deps[name]; }, loaded, loaded.exports);
    return loaded.exports;
  };
  return {
    state, database, tenant,
    characters: load<typeof Characters>("lib/higgsfield-consumer/characters.ts"),
    elements: load<typeof Elements>("lib/higgsfield-consumer/elements.ts"),
    ledger: async () => (await database.db().execute("SELECT kind,name,state,provider_id FROM higgsfield_consumer_builds ORDER BY created_at,rowid")).rows.map((row) => [String(row.kind), String(row.name), String(row.state), row.provider_id == null ? null : String(row.provider_id)]),
  };
}
const soulSources = [{ uploadId: "a" }, { uploadId: "b" }, { uploadId: "c" }, { uploadId: "d" }, { uploadId: "e" }];

test("every way a Soul ID build ends is kept in the ledger; one accepted without an id is matched to the account's list later", async () => {
  const f = await buildServices();
  await f.tenant.runInTenant(workspace(), async () => {
    const build = (name: string) => f.characters.buildConnectedCharacter("owner", { name, type: "soul_2", sources: soulSources, projectId: "ws-1" });
    // Stopped before the create went out: closed as not_sent, and free to try again.
    f.state.mode = "not_sent";
    await expect(build("Mira")).rejects.toThrow("Stopped before the create was sent");
    // The account said no: closed as refused.
    f.state.mode = "refused";
    expect(await build("Mira")).toEqual({ state: "refused", reason: "Not on this plan." });
    // The answer was lost: kept open, and the same build is refused before anything is sent.
    f.state.mode = "uncertain";
    expect(await build("Mira")).toEqual({ state: "uncertain" });
    const sends = f.state.creates;
    await expect(build("Mira")).rejects.toMatchObject({ code: "build_in_flight", status: 409 });
    expect(f.state.creates).toBe(sends);
    // Accepted without an id: pending until the account lists it.
    f.state.mode = "pending";
    expect(await build("Nova")).toEqual({ state: "accepted", character: null });
    // Named at once: recorded and listed.
    f.state.mode = "created";
    expect(await build("Ada")).toMatchObject({ state: "training", character: { soulId: "soul_made" } });
    expect(await f.ledger()).toEqual([
      ["character", "Mira", "not_sent", null], ["character", "Mira", "refused", null], ["character", "Mira", "uncertain", null],
      ["character", "Nova", "pending", null], ["character", "Ada", "recorded", "soul_made"],
    ]);
    // The account now lists a "Nova" made just after the send (and an older one of its own).
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    f.state.list = [
      { soul_id: "soul_made", name: "Ada", type: "soul_2", status: "training", created_at: at(0) },
      { soul_id: "soul_nova", name: "Nova", type: "soul_2", status: "training", created_at: at(1) },
      { soul_id: "soul_site", name: "Nova", type: "soul_2", status: "ready", created_at: at(-600) },
    ];
    const listed = await f.characters.connectedCharacters("owner");
    expect(listed.characters.map((c) => c.soulId).sort()).toEqual(["soul_made", "soul_nova"]);
    expect(listed.pending?.map((b) => [b.name, b.state])).toEqual([["Mira", "uncertain"]]);
    // Builds still open page the list further.
    expect(f.state.reads.at(-1)).toMatchObject({ paging: true });
    expect((await f.ledger()).find((row) => row[1] === "Nova")).toEqual(["character", "Nova", "recorded", "soul_nova"]);
    expect((await f.characters.connectedCharacters("owner")).characters.map((c) => c.soulId).sort()).toEqual(["soul_made", "soul_nova"]);
  });
});

test("reference elements keep the same ledger: pending builds are listed as pending, then matched", async () => {
  const f = await buildServices();
  await f.tenant.runInTenant(workspace(), async () => {
    const build = () => f.elements.buildConnectedElement("owner", { name: "Harbour", category: "environment", description: "", sources: [{ genId: "gen_1" }], projectId: "ws-1" });
    f.state.mode = "pending";
    expect(await build()).toEqual({ state: "accepted", element: null });
    await expect(build()).rejects.toMatchObject({ code: "build_in_flight" });
    f.state.list = [];
    const waiting = await f.elements.connectedElements("owner");
    expect(waiting).toMatchObject({ available: true, elements: [] });
    expect(waiting.pending?.map((b) => [b.name, b.state, b.stale])).toEqual([["Harbour", "pending", false]]);
    expect(f.state.reads.at(-1)).toMatchObject({ paging: true });
    f.state.list = [{ element_id: "el_harbour", name: "Harbour", category: "environment", created_at: new Date(Date.now() + 60_000).toISOString() }];
    const matched = await f.elements.connectedElements("owner");
    expect(matched.elements.map((e) => e.elementId)).toEqual(["el_harbour"]);
    expect(matched.pending).toEqual([]);
    expect(await f.ledger()).toEqual([["element", "Harbour", "recorded", "el_harbour"]]);
    // Nothing left open: the next read does not page for builds.
    await f.elements.connectedElements("owner");
    expect(f.state.reads.at(-1)).toMatchObject({ paging: false });
  });
});
