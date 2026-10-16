import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution, AdmissionReply, PreparedAdmission } from "../../lib/admissionTypes";

/**
 * cast_character (lib/castCharacter.ts, POST /api/cast-character, the MCP tool): an AI-made character, in one go, for one price. Mocked: FLUX.2 runs on its in-process fixture
 * under ENGINE_MOCK=1; Nano Banana is a stand-in for the generation admission that writes a finished still; no request leaves this process and no provider is paid.
 * Local temporary databases only. Neutral sample names.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cast-character-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.beforeEach(() => { process.env.BFL_ENABLED = "1"; process.env.BFL_IDENTITY_ENABLED = "1"; });
test.afterEach(() => { delete process.env.BFL_ENABLED; delete process.env.BFL_IDENTITY_ENABLED; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
let n = 0;
const stamp = () => `cv_${Date.now().toString(36)}${++n}`;
const made: string[] = [];
test.afterAll(async () => { for (const f of made) await unlink(f).catch(() => {}); });
async function asTenant(ws: TenantWorkspace, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, OWNER as never);
}
const options = (): AdmissionExecution => ({ defer: async () => {} });
async function admit(body: Record<string, unknown>, seams: import("../../lib/castCharacter").CastSeams = {}, actor: AdmissionActor = OWNER, execution: AdmissionExecution = options()) {
  const { admitCastCharacter } = await import("../../lib/castCharacter");
  return admitCastCharacter(body, actor, execution, { waitMs: 20_000, ...seams });
}
const rows = async (sql: string, args: (string | number)[] = []) => {
  const { db, ready } = await import("../../lib/db");
  await ready();
  return (await db().execute({ sql, args })).rows;
};
const count = async (table: string) => Number((await rows(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
async function meter(engine: string) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute({ sql: "SELECT id,status,billed_credits,workspace_id FROM meter_events WHERE engine=? ORDER BY created_at, id", args: [engine] })).rows;
}
/** Files this test wrote, to clean up. */
async function track() {
  for (const r of await rows("SELECT id, ext FROM uploads WHERE filename LIKE 'cast-%'")) made.push(path.join(process.cwd(), ".data", "uploads", `${r.id}.${r.ext}`));
  for (const r of await rows("SELECT id FROM generations WHERE json_extract(params,'$.cast.version') IS NOT NULL")) made.push(path.join(process.cwd(), ".data", "generations", `${r.id}.png`));
}
const WHO = { name: "Maya", description: "a ship's captain in her fifties, weathered, grey hair tied back" };
const FLUX_NAMES = /flux|bfl|banana|gemini|google/i;

/** Nano Banana's stand-in: priced from a table, and a finished still written for each admitted job; the sheet (with its reference) costs more, as a reference does. */
function fakeNano(over: { failSheet?: boolean; sheetExtra?: number } = {}) {
  const calls: string[] = [];
  const prepare = async (body: Record<string, unknown>, actor: AdmissionActor) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const references = (body.references as unknown[] | undefined) ?? [];
    const usd = 0.134 + (references.length ? (over.sheetExtra ?? 0.0011) : 0);
    const credits = billCredits(usd, "gemini-3-pro-image");
    const quote = { estimatedCredits: credits, price: credits, unit: "cr" as const };
    const compiled = { prompt: body.prompt, references };
    return { ok: true as const, value: { version: 1 as const, kind: "image" as const, workspaceId: "w", actorId: actor.user.id, request: { ...body, maxCredits: credits }, compiled, quote: { ...quote, fingerprint: `fp_${String(body.prompt).length}_${references.length}` } } satisfies PreparedAdmission };
  };
  const admit = async (prepared: PreparedAdmission, _actor: AdmissionActor, o: { requestKey: string }): Promise<AdmissionReply> => {
    const { db, id, now, ready } = await import("../../lib/db");
    const { storeImageBytes } = await import("../../lib/storage");
    await ready();
    calls.push(o.requestKey);
    const refs = (prepared.request.references as unknown[] | undefined) ?? [];
    if (over.failSheet && refs.length) return { status: 422, body: { error: "The picture was refused. Nothing was billed." } };
    const genId = id("gen");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const stored = await storeImageBytes(genId, png);
    await db().execute({ sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,stored_url,bytes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", args: [genId, null, "image", "gemini-3-pro-image", String(prepared.request.prompt), "{}", "succeeded", stored.url, stored.bytes, "owner", now(), now()] });
    return { status: 202, body: { id: genId, status: "succeeded" } };
  };
  return { seams: { nanobanana: { prepare, admit } } as import("../../lib/castCharacter").CastSeams, calls };
}

test("the tool is declared once, offered over MCP with an approval it never takes, and asks a person (never a draft)", async () => {
  const { CAST_CHARACTER_TOOL } = await import("../../lib/castCharacter");
  expect(CAST_CHARACTER_TOOL).toMatchObject({ id: "cast_character", route: "/api/cast-character", kind: "engine" });
  expect(CAST_CHARACTER_TOOL.who).toBe("prepare: anyone; approve: a person");
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  await asTenant(house(), async () => {
    const tool = (await directEngineMcpTools()).find((t) => t.name === "cast_character")!;
    expect(tool.description).toContain("never you");
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/maxCredits|max_credits/);
    const calls: { path: string; body?: Record<string, unknown> }[] = [];
    const call = async (p: string, init?: { body?: unknown }) => {
      calls.push({ path: p, body: (init?.body ?? {}) as Record<string, unknown> });
      if (p === "/api/cast-character") return { estimatedCredits: 9, price: 9, unit: "cr", upTo: true, stills: 2, sheet: true };
      return { job: { id: "prep_1" } };
    };
    const said = await runDirectEngineTool("cast_character", { name: "Maya", description: "a ship's captain" }, call as never);
    expect(said).toMatch(/Priced and prepared, not started/);
    expect(said).toMatch(/9 cr/);
    /* It quoted, then filed the job for a person; it never sent an approval of its own. */
    expect(calls.map((c) => c.path)).toEqual(["/api/cast-character", "/api/prepared-jobs"]);
    expect(calls[0].body).toMatchObject({ name: "Maya", quoteOnly: true });
    expect(calls.some((c) => "maxCredits" in (c.body ?? {}))).toBe(false);
    await expect(runDirectEngineTool("cast_character", { name: "Maya", description: "x", maxCredits: 9 } as never, call as never)).rejects.toThrow(/not yours to approve/);
  });
  const route = readFileSync("app/api/cast-character/route.ts", "utf8");
  expect(route).toContain("requireRender()");
  expect(route).toContain("sampleWorkspaceOff");
  expect(route).toContain("withGenerationRequest");
  const lib = readFileSync("lib/castCharacter.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  expect(lib).not.toMatch(/reserveGenerationSpend|fetch\(|consent|rekognition|faceSha|faceMatch/i);
});

test("the quote is ONE price for the whole character, written nowhere and naming no engine; words first", async () => {
  await asTenant(house(), async () => {
    const before = { gens: await count("generations"), meters: (await meter("bfl")).length, cast: await count("cast_members"), ids: await count("identities"), ups: await count("uploads") };
    const q = await admit({ ...WHO, quoteOnly: true });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body).toMatchObject({ upTo: true, stills: 2, sheet: true, unit: "usd" });
    expect(Number(q.body.estimatedCredits)).toBeGreaterThan(0);
    expect(JSON.stringify(q.body)).not.toMatch(FLUX_NAMES);
    expect(Object.keys(q.body).sort()).toEqual(["estimatedCredits", "price", "sheet", "stills", "unit", "upTo"]);
    /* Without the sheet it is the portrait alone, and cheaper. */
    const alone = await admit({ ...WHO, sheet: false, quoteOnly: true });
    expect(alone.body).toMatchObject({ stills: 1, sheet: false });
    expect(Number(alone.body.estimatedCredits)).toBeLessThan(Number(q.body.estimatedCredits));
    expect({ gens: await count("generations"), meters: (await meter("bfl")).length, cast: await count("cast_members"), ids: await count("identities"), ups: await count("uploads") }).toEqual(before);
    for (const [bad, status] of [[{ name: "1bad" }, 400], [{ name: "image2" }, 400], [{ description: "" }, 400], [{ description: "x".repeat(601) }, 400], [{ engine: "gold" }, 400], [{ sheet: "yes" }, 400], [{ projectId: "../x" }, 400], [{ projectId: "prj_none" }, 404]] as const)
      expect((await admit({ ...WHO, ...bad, quoteOnly: true })).status, JSON.stringify(bad)).toBe(status);
  });
});

test("a person approves once, for everything: nothing runs without it, under it, or from a machine (a token, an agent, Auto, no person)", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  const { db, ready } = await import("../../lib/db");
  await asTenant(house(), async () => {
    const total = Number((await admit({ ...WHO, quoteOnly: true })).body.estimatedCredits);
    const before = { gens: await count("generations"), meters: (await meter("bfl")).length };
    expect(await admit({ ...WHO, versionId: stamp() })).toMatchObject({ status: 409, body: { error: expect.stringContaining("Approve the price first") } });
    expect((await admit({ ...WHO, versionId: stamp(), maxCredits: total - 1 })).status).toBe(409);
    expect((await admit({ ...WHO, maxCredits: total })).status).toBe(400);
    const token = { id: "tok_cast", scope: "render" } as never;
    await runInTenant(house(), async () => {
      expect((await admit({ ...WHO, quoteOnly: true }, {}, { ...OWNER, token })).status).toBe(200);
      expect(await admit({ ...WHO, versionId: stamp(), maxCredits: total }, {}, { ...OWNER, token })).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
    }, { user: OWNER.user, token } as never);
    expect(await admit({ ...WHO, versionId: stamp(), maxCredits: total }, {}, OWNER, { ...options(), run: { auto: true } as never })).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
    /* An Atomik run acts for its owner: it may ask the price, never approve. A run with no person behind it asks nothing. */
    await ready(); await rigAgentReady();
    await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: ["run_cast", "prod_x", "draft_x", "owner", "req_cast", "goal", "auto", "finished"] });
    const agent: AdmissionActor = { user: { ...OWNER.user, id: "agent:run_cast", role: "member", owner: false } as AdmissionActor["user"] };
    await runInTenant(house(), async () => {
      expect((await admit({ ...WHO, quoteOnly: true }, {}, agent)).status).toBe(200);
      expect(await admit({ ...WHO, versionId: stamp(), maxCredits: total }, {}, agent)).toMatchObject({ status: 403, body: { error: expect.stringMatching(/Only a person approves/) } });
    }, { user: agent.user } as never);
    const lost: AdmissionActor = { user: { ...agent.user, id: "agent:run_nobody" } as AdmissionActor["user"] };
    await runInTenant(house(), async () => {
      expect(await admit({ ...WHO, quoteOnly: true }, {}, lost)).toMatchObject({ status: 403, body: { error: "A person must be behind this request to use their uploads." } });
    }, { user: lost.user } as never);
    expect({ gens: await count("generations"), meters: (await meter("bfl")).length }).toEqual(before);
  });
});

test("FLUX.2: portrait, then the sheet from the portrait, kept as the person's uploads; the cast member and the identity written together; the price is the one approved and the identity is usable at once", async () => {
  await asTenant(house(), async () => {
    const total = Number((await admit({ ...WHO, name: "Maya", quoteOnly: true })).body.estimatedCredits);
    const meters = (await meter("bfl")).length;
    const version = stamp();
    const r = await admit({ ...WHO, versionId: version, maxCredits: total });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: "done", versionId: version, name: "Maya", estimatedCredits: total });
    expect(Number(r.body.spent)).toBeGreaterThan(0);
    expect(Number(r.body.spent)).toBeLessThanOrEqual(total);
    expect(JSON.stringify(r.body)).not.toMatch(FLUX_NAMES);
    await track();
    /* Two stills billed once each, the sheet made from the portrait as its only reference. */
    expect((await meter("bfl")).length - meters).toBe(2);
    const takes = await rows("SELECT id, json_extract(params,'$.cast.role') AS role, json_extract(params,'$.bfl.references') AS refs, json_extract(params,'$.bfl.tool') AS tool, status FROM generations WHERE json_extract(params,'$.cast.version')=? ORDER BY created_at", [version]);
    expect(takes.map((t) => [t.role, t.tool, t.status])).toEqual([["portrait", "image", "succeeded"], ["sheet", "edit", "succeeded"]]);
    const portraitUp = String(r.body.portraitUploadId), sheetUp = String(r.body.sheetUploadId);
    expect(JSON.parse(String(takes[1].refs))).toEqual([expect.objectContaining({ uploadId: portraitUp })]);
    /* The stills are the person's own uploads, in the Library. */
    expect((await rows("SELECT filename, kind, uploader_id, width, height FROM uploads WHERE id IN (?,?) ORDER BY filename", [portraitUp, sheetUp])).map((u) => [u.filename, u.kind, u.uploader_id])).toEqual([[`cast-${version}-portrait.png`, "image", "owner"], [`cast-${version}-sheet.png`, "image", "owner"]]);
    /* The cast member holds the portrait; the identity holds the portrait first and the sheet; each knows the other. */
    const cast = (await rows("SELECT * FROM cast_members WHERE id=?", [String(r.body.castId)]))[0];
    expect(cast).toMatchObject({ name: "Maya", kind: "character", upload_id: portraitUp, created_by: "owner" });
    expect(String(cast.description)).toBe(WHO.description);
    const idn = (await rows("SELECT * FROM identities WHERE id=?", [String(r.body.identityId)]))[0];
    expect(JSON.parse(String(idn.photos))).toEqual([portraitUp, sheetUp]);
    expect(idn).toMatchObject({ name: "Maya", cover_upload_id: portraitUp, cast_id: String(r.body.castId), status: "draft" });
    /* No consent is asked or kept anywhere. */
    expect(idn.consent_by ?? null).toBeNull();
    /* The identity works in FLUX.2 at once, as the identity tool: its photos are the references. */
    const { executeBflAdmission } = await import("../../lib/bflImage");
    const use = await executeBflAdmission({ tool: "identity", identityId: String(r.body.identityId), prompt: "Maya at the helm at dawn", quoteOnly: true }, OWNER, options());
    expect(use.status, JSON.stringify(use.body)).toBe(200);
    expect(use.body).toMatchObject({ tool: "identity", references: 2 });
    /* A retry under the same version buys nothing and answers the same character. */
    const again = await admit({ ...WHO, versionId: version, maxCredits: total });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ castId: r.body.castId, identityId: r.body.identityId, portraitUploadId: portraitUp });
    expect((await meter("bfl")).length - meters).toBe(2);
    expect(await count("cast_members")).toBe(Number((await rows("SELECT COUNT(*) AS n FROM cast_members"))[0].n));
    /* The name is taken now. */
    expect(await admit({ ...WHO, quoteOnly: true })).toMatchObject({ status: 409, body: { error: "@Maya is already cast here." } });
    /* Where it stands, for a screen. */
    const { castCharacterStatus } = await import("../../lib/castCharacter");
    expect(await castCharacterStatus(version, "owner")).toMatchObject({ portrait: "succeeded", sheet: "succeeded", done: true, castId: r.body.castId, identityId: r.body.identityId });
    expect(await castCharacterStatus("cv_none_here", "owner")).toBeNull();
  });
});

test("Nano Banana is the other engine: the same character on the generation admission; a refused sheet stops with the portrait kept and nothing bought twice; a retry finishes it; a step past the approved total asks again", async () => {
  await asTenant(house(), async () => {
    const nb = fakeNano({ failSheet: true });
    const total = Number((await admit({ ...WHO, name: "Rowan", engine: "nanobanana", quoteOnly: true }, nb.seams)).body.estimatedCredits);
    expect(total).toBeGreaterThan(0);
    const version = stamp();
    /* The sheet is refused: the portrait is kept, the cast and identity are not made, and the reply says what a retry is. */
    const stopped = await admit({ ...WHO, name: "Rowan", engine: "nanobanana", versionId: version, maxCredits: total }, nb.seams);
    expect(stopped.status).toBe(422);
    expect(stopped.body).toMatchObject({ error: expect.stringContaining("The sheet: The picture was refused. Nothing was billed."), versionId: version, retry: expect.stringContaining("same versionId") });
    expect(nb.calls).toEqual([`cast:${version}:portrait`, `cast:${version}:sheet`]);
    expect((await rows("SELECT COUNT(*) AS n FROM cast_members WHERE name='Rowan'"))[0].n).toBe(0);
    expect((await rows("SELECT COUNT(*) AS n FROM uploads WHERE filename=?", [`cast-${version}-portrait.png`]))[0].n).toBe(1);
    /* The retry makes only the sheet. */
    const good = fakeNano();
    const done = await admit({ ...WHO, name: "Rowan", engine: "nanobanana", versionId: version, maxCredits: total }, good.seams);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "done", name: "Rowan" });
    expect(good.calls).toEqual([`cast:${version}:sheet`]);
    expect((await rows("SELECT COUNT(*) AS n FROM uploads WHERE filename LIKE ?", [`cast-${version}-%`]))[0].n).toBe(2);
    await track();
    /* A sheet that costs more than its estimate (a reference is priced with the still) is not run past the approved total. */
    const dear = fakeNano({ sheetExtra: 5 });
    const q = Number((await admit({ ...WHO, name: "Ines", engine: "nanobanana", quoteOnly: true }, dear.seams)).body.estimatedCredits);
    const v2 = stamp();
    const over = await admit({ ...WHO, name: "Ines", engine: "nanobanana", versionId: v2, maxCredits: q }, dear.seams);
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: expect.stringContaining("past the approved amount, so it asks again") });
    expect(dear.calls).toEqual([`cast:${v2}:portrait`]);
    const more = await admit({ ...WHO, name: "Ines", engine: "nanobanana", versionId: v2, maxCredits: q + 100 }, dear.seams);
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(dear.calls).toEqual([`cast:${v2}:portrait`, `cast:${v2}:sheet`]);
    await track();
  });
});

test("the sheet is optional, the cast and the identity are written together or not at all, and a name taken meanwhile stops with the stills kept", async () => {
  await asTenant(house(), async () => {
    const q = Number((await admit({ ...WHO, name: "Pia", sheet: false, quoteOnly: true })).body.estimatedCredits);
    const solo = await admit({ ...WHO, name: "Pia", sheet: false, versionId: stamp(), maxCredits: q });
    expect(solo.status, JSON.stringify(solo.body)).toBe(200);
    expect(solo.body.sheetUploadId).toBeUndefined();
    const idn = (await rows("SELECT photos, cover_upload_id FROM identities WHERE id=?", [String(solo.body.identityId)]))[0];
    expect(JSON.parse(String(idn.photos))).toEqual([solo.body.portraitUploadId]);
    /* Someone casts the same name while the stills are being made: neither the cast member nor the identity is written, and the stills stay in the Library. */
    const { db } = await import("../../lib/db");
    const nb = fakeNano();
    const raced: typeof nb.seams = { ...nb.seams, nanobanana: { ...nb.seams.nanobanana!, admit: async (...args) => {
      const out = await nb.seams.nanobanana!.admit(...args);
      await db().execute({ sql: "INSERT OR IGNORE INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)", args: ["cast_raced", null, "Tess", "character", "", null, "owner", Date.now()] });
      return out;
    } } };
    const v = stamp();
    const lost = await admit({ ...WHO, name: "Tess", engine: "nanobanana", sheet: false, versionId: v, maxCredits: 1000 }, raced);
    expect(lost.status).toBe(409);
    expect(lost.body).toMatchObject({ error: "@Tess is already cast here.", portraitUploadId: expect.any(String) });
    expect((await rows("SELECT COUNT(*) AS n FROM identities WHERE LOWER(name)='tess'"))[0].n).toBe(0);
    await track();
  });
});

test("a listed customer workspace pays in credits what the character costs, once, inside the approved total; one at its own $0 cap is refused in the cap's words with nothing held or written", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  await platformReady();
  const make = async (id: string, allowance: number | null) => {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, allowance] });
    await grantCredits(id, 500, "Test", "owner", "manual");
    return (await getWorkspace(id))!;
  };
  const open = await make("ws_cast_listed", null), capped = await make("ws_cast_capped", 0);
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const setSite = (v: unknown) => platformDb().execute({ sql: "INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [JSON.stringify(v)] });
  try {
    await setSite({ enginesOnWorkspaces: ["ws_cast_listed", "ws_cast_capped"] });
    await asTenant(open, async () => {
      const q = await admit({ ...WHO, name: "Lena", quoteOnly: true });
      expect(q.body).toMatchObject({ unit: "cr", stills: 2 });
      const total = Number(q.body.estimatedCredits);
      const before = (await creditState())!.balance;
      const r = await admit({ ...WHO, name: "Lena", versionId: stamp(), maxCredits: total });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const mine = (await meter("bfl")).filter((m) => m.workspace_id === "ws_cast_listed");
      expect(mine).toHaveLength(2);
      const paid = mine.reduce((s, m) => s + Number(m.billed_credits), 0);
      expect(paid).toBe(Number(r.body.spent));
      expect(paid).toBeLessThanOrEqual(total);
      expect((await creditState())!.balance).toBeCloseTo(before - paid, 6);
      await track();
    });
    await asTenant(capped, async () => {
      const q = await admit({ ...WHO, name: "Lena", quoteOnly: true });
      const r = await admit({ ...WHO, name: "Lena", versionId: stamp(), maxCredits: Number(q.body.estimatedCredits) });
      expect(r.status, JSON.stringify(r.body)).toBe(429);
      expect(String(r.body.error).replace(/^The (portrait|sheet): /, "")).not.toMatch(/\$|\d/);
      expect((await meter("bfl")).filter((m) => m.workspace_id === "ws_cast_capped")).toHaveLength(0);
      expect(await count("cast_members")).toBe(0);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});
