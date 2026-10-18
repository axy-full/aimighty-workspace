import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution, AdmissionReply } from "../../lib/admissionTypes";
import type { CastEntry } from "../../lib/production/cast";

/**
 * The Cast tool (lib/castCharacter.ts, POST /api/cast-character, MCP cast_character): an AI-made character, its identity and its eight-still sheet under one price and
 * one approval. Mocked: the engines are functions this file hands the plan (the internal seams `admitCastCharacter` takes; the route and the MCP tool offer none), so no
 * request leaves this process and no provider is paid. Local temporary databases only. Neutral sample names.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cast-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.beforeEach(() => { process.env.BFL_ENABLED = "1"; process.env.BFL_IDENTITY_ENABLED = "1"; process.env.BFL_API_KEY = "test-key"; });
test.afterEach(() => { delete process.env.BFL_ENABLED; delete process.env.BFL_IDENTITY_ENABLED; delete process.env.BFL_API_KEY; });

const tenant = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null,
} as TenantWorkspace);
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
const agent = (run: string): AdmissionActor => ({ user: { ...OWNER.user, id: `agent:${run}`, role: "member", owner: false } as AdmissionActor["user"] });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let n = 0;
const uid = (label: string) => `${label}${Date.now().toString(36)}${++n}`;
const files: string[] = [];
test.afterAll(async () => { for (const f of files) await unlink(f).catch(() => {}); });
const BIG = 100000;

async function asTenant(ws: TenantWorkspace, who: AdmissionActor, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, who as never);
}
const options = (): AdmissionExecution => ({ defer: async (work) => { await work(); } });

/** FLUX.2 as a stand-in: quotes through the adapter's own price path and makes a finished still per approved step. */
function fakeFlux2(over: { failTool?: string; failAt?: number; bump?: number } = {}) {
  const calls: { tool: string; quoteOnly: boolean; maxCredits?: number; identityId?: string; prompt: string; credits: number }[] = [];
  let made = 0;
  let refused = false;
  const run = async (input: Record<string, unknown>): Promise<AdmissionReply> => {
    const { bflQuote, megapixels } = await import("../../lib/bflImage");
    const { quotedCredits } = await import("../../lib/credits");
    const { creditsApply } = await import("../../lib/credits");
    const { requireTenant } = await import("../../lib/tenant");
    const { admissionReply } = await import("../../lib/admissionSupport");
    const { db } = await import("../../lib/db");
    const { storeImageBytes } = await import("../../lib/storage");
    const tool = String(input.tool);
    const mp = megapixels(Number(input.width), Number(input.height));
    const priced = bflQuote(input.model as "flux-2-pro", mp, tool === "identity" ? [mp] : []);
    if ("error" in priced) return admissionReply({ error: priced.error }, { status: 400 });
    const credits = quotedCredits(priced.usd, String(input.model)) + (tool === "identity" ? over.bump ?? 0 : 0);
    const quoteOnly = input.quoteOnly === true;
    calls.push({ tool, quoteOnly, maxCredits: input.maxCredits as number | undefined, identityId: input.identityId as string | undefined, prompt: String(input.prompt), credits });
    const inCredits = creditsApply(requireTenant());
    if (quoteOnly) return admissionReply({ estimatedCredits: credits, price: inCredits ? credits : priced.usd, unit: inCredits ? "cr" : "usd", tool, model: input.model });
    if (!Number.isInteger(input.maxCredits) || credits > (input.maxCredits as number)) return admissionReply({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
    if (tool === over.failTool && !refused && made + 1 === (over.failAt ?? 1)) { refused = true; return admissionReply({ error: "Refused by the provider. Nothing billed." }, { status: 502 }); }
    made += 1;
    const genId = uid("gen");
    await db().execute({
      sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes) VALUES(?,?,?,?,?,1,1,'image',0,'owner',NULL,?,?)",
      args: [genId, String(input.model), String(input.prompt), "{}", "succeeded", `/stored/${genId}.png`, PNG.length],
    });
    await storeImageBytes(genId, PNG);
    files.push(path.join(process.cwd(), ".data", "generations", `${genId}.png`));
    return admissionReply({ id: genId, status: "running", estimatedCredits: credits, model: input.model });
  };
  return { run, calls, made: () => made };
}
async function identitiesCount(): Promise<number> {
  const { db, ready } = await import("../../lib/db");
  await ready();
  return Number((await db().execute("SELECT COUNT(*) AS n FROM identities")).rows[0].n);
}

const base = (extra: Record<string, unknown> = {}) => ({ name: "Mira", description: "a tall woman in her thirties with short silver hair, a worn green coat and a calm, watchful face", ...extra });

test("the quote is one all-in price for eight stills and names no engine; Director's detail names it", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { admitCastCharacter, CAST_STILLS } = await import("../../lib/castCharacter");
    const fake = fakeFlux2();
    const quote = await admitCastCharacter(base({ quoteOnly: true }), OWNER, options(), { flux2: fake.run });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ stills: CAST_STILLS, upTo: true, name: "Mira" });
    expect(Number(quote.body.estimatedCredits)).toBeGreaterThan(0);
    /* Agent mode and an outside agent read one price: no engine, no model, no step, no vendor word. */
    expect(Object.keys(quote.body).sort()).toEqual(["estimatedCredits", "name", "price", "stills", "unit", "upTo"]);
    expect(JSON.stringify(quote.body)).not.toMatch(/flux|bfl|black forest|nano|banana|gemini|model|engine/i);
    /* Nothing was made or bought by asking. */
    expect(fake.made()).toBe(0);
    expect(await identitiesCount()).toBe(0);
    const detail = await admitCastCharacter(base({ quoteOnly: true, detail: true }), OWNER, options(), { flux2: fake.run });
    expect(detail.body).toMatchObject({ engine: "flux2", model: "flux-2-pro" });
    expect((detail.body.steps as unknown[]).length).toBe(CAST_STILLS);
    expect(detail.body.estimatedCredits).toBe(quote.body.estimatedCredits);
  }, );
});

test("the plan: the front still from words, the identity kept once, seven views of the same person, the board's Cast written; each step asked at its own exact quote, and the total is the quote", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { admitCastCharacter, CAST_ANGLES, CAST_STILLS } = await import("../../lib/castCharacter");
    const { db } = await import("../../lib/db");
    const fake = fakeFlux2();
    const written: { owner: string; draftId: string; entry: CastEntry }[] = [];
    const seams = { flux2: fake.run, draft: async (owner: string, draftId: string, entry: CastEntry) => { written.push({ owner, draftId, entry }); return { written: true }; } };
    const quote = await admitCastCharacter(base({ quoteOnly: true }), OWNER, options(), seams);
    const total = Number(quote.body.estimatedCredits);
    const before = await identitiesCount();
    const characterId = uid("char");
    const reply = await admitCastCharacter(base({ characterId, maxCredits: total, draftId: "d1" }), OWNER, options(), seams);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ status: "done", made: CAST_STILLS, stopped: 0, characterId, spent: total });
    const stills = reply.body.stills as { angle: string; takeId: string; status: string }[];
    expect(stills.map((s) => s.angle)).toEqual(CAST_ANGLES.map((a) => a.id));
    expect(stills.every((s) => s.status === "succeeded")).toBe(true);
    /* Quote equals charge: every step was asked at exactly its own quote, never over it, and together they are the plan's total. */
    const asked = fake.calls.filter((c) => !c.quoteOnly);
    expect(asked).toHaveLength(CAST_STILLS);
    for (const c of asked) expect(c.maxCredits).toBe(c.credits);
    expect(asked.reduce((sum, c) => sum + (c.maxCredits ?? 0), 0)).toBe(total);
    /* The front is made from words alone; the seven others are of the identity, which is kept once, from the front. */
    expect(asked[0]).toMatchObject({ tool: "image" });
    expect(asked.slice(1).every((c) => c.tool === "identity" && c.identityId === reply.body.identityId)).toBe(true);
    expect(await identitiesCount()).toBe(before + 1);
    const identity = (await db().execute({ sql: "SELECT name, photos, status FROM identities WHERE id=?", args: [reply.body.identityId as string] })).rows[0];
    expect(identity.name).toBe("Mira");
    expect(JSON.parse(String(identity.photos))).toHaveLength(1);
    const photo = (await db().execute({ sql: "SELECT kind, uploader_id, width, height FROM uploads WHERE id=?", args: [JSON.parse(String(identity.photos))[0]] })).rows[0];
    expect(photo).toMatchObject({ kind: "image", uploader_id: "owner" });
    /* The takes are the record: each carries its sheet and angle. */
    const tagged = (await db().execute({ sql: "SELECT json_extract(params,'$.cast.angle') AS angle FROM generations WHERE json_extract(params,'$.cast.character')=? ORDER BY created_at", args: [characterId] })).rows.map((r) => String(r.angle));
    expect(tagged.sort()).toEqual(CAST_ANGLES.map((a) => a.id).sort());
    /* The board's Cast: one character entry, its identity, its eight stills with the front first and selected. */
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ owner: "owner", draftId: "d1" });
    expect(written[0].entry).toMatchObject({ kind: "character", name: "Mira", identityId: reply.body.identityId, selected: stills[0].takeId });
    expect(written[0].entry.takes.map((t) => t.genId)).toEqual(stills.map((s) => s.takeId));
  });
});

test("only a person approves: an agent's run, a token and Auto are refused before anything is asked, and an approval below the price asks again", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { admitCastCharacter, CAST_RETRY_NOTE } = await import("../../lib/castCharacter");
    void CAST_RETRY_NOTE;
    const fake = fakeFlux2();
    const seams = { flux2: fake.run };
    const quote = await admitCastCharacter(base({ name: "Vera", quoteOnly: true }), OWNER, options(), seams);
    const total = Number(quote.body.estimatedCredits);
    fake.calls.length = 0;
    const attempt = { name: "Vera", characterId: uid("char"), maxCredits: total };
    expect((await admitCastCharacter(base(attempt), agent("run1"), options(), seams)).status).toBe(403);
    const token = { ...OWNER, token: { id: "tok", name: "t", capUsd: null, capCredits: null } } as unknown as AdmissionActor;
    expect(await admitCastCharacter(base(attempt), token, options(), seams)).toMatchObject({ status: 403 });
    expect(await admitCastCharacter(base(attempt), OWNER, { ...options(), run: { auto: true } } as never, seams)).toMatchObject({ status: 403 });
    /* Below the price, or no figure, or no sheet name: refused, nothing bought. */
    expect(await admitCastCharacter(base({ ...attempt, maxCredits: total - 1 }), OWNER, options(), seams)).toMatchObject({ status: 409 });
    expect(await admitCastCharacter(base({ name: "Vera", characterId: attempt.characterId }), OWNER, options(), seams)).toMatchObject({ status: 409 });
    expect(await admitCastCharacter(base({ name: "Vera", maxCredits: total }), OWNER, options(), seams)).toMatchObject({ status: 400 });
    expect(fake.calls.filter((c) => !c.quoteOnly)).toEqual([]);
    expect(fake.made()).toBe(0);
  });
});

test("a plan that cannot finish stops, not spends: a view that would pass the approved total asks again, what is made is not bought twice on the retry, and the identity is kept once", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { admitCastCharacter, CAST_STILLS } = await import("../../lib/castCharacter");
    const characterId = uid("char");
    const dearer = fakeFlux2({ bump: 1000 });
    const total = Number((await admitCastCharacter(base({ name: "Nora", quoteOnly: true }), OWNER, options(), { flux2: dearer.run })).body.estimatedCredits);
    const before = await identitiesCount();
    /* Each view's own quote comes in above what the plan estimated: the front is made, the views ask again, and nothing past the approval is spent. */
    const limited = await admitCastCharacter(base({ name: "Nora", characterId, maxCredits: total }), OWNER, options(), { flux2: dearer.run });
    expect(limited.body).toMatchObject({ status: "partial", made: 1, stopped: CAST_STILLS - 1 });
    expect(Number(limited.body.spent)).toBeLessThanOrEqual(total);
    expect(String(limited.body.retry)).toMatch(/same characterId/);
    expect((limited.body.stills as { stopped?: string }[]).filter((s) => /past the approved amount/.test(s.stopped ?? ""))).toHaveLength(CAST_STILLS - 1);
    expect(dearer.calls.filter((c) => !c.quoteOnly)).toHaveLength(1);
    const identityAfter = await identitiesCount();
    expect(identityAfter).toBe(before + 1);
    /* One more approval, for the rest: only what is missing is bought, and the identity is not made again. */
    const fair = fakeFlux2();
    const again = await admitCastCharacter(base({ name: "Nora", characterId, maxCredits: total }), OWNER, options(), { flux2: fair.run });
    expect(again.body).toMatchObject({ status: "done", stopped: 0, made: CAST_STILLS });
    expect(fair.made()).toBe(CAST_STILLS - 1);
    expect(fair.calls.filter((c) => !c.quoteOnly && c.tool === "image")).toEqual([]);
    expect(await identitiesCount()).toBe(identityAfter);
    /* A view the provider refuses costs nothing and is simply missing; the rest of the sheet goes on. */
    const refusing = fakeFlux2({ failTool: "identity", failAt: 2 });
    const part = await admitCastCharacter(base({ name: "Odo", characterId: uid("char"), maxCredits: total }), OWNER, options(), { flux2: refusing.run });
    expect(part.body).toMatchObject({ status: "partial", stopped: 1 });
    expect(Number(part.body.spent)).toBeLessThan(total);
  });
});

test("a refused front still costs nothing and makes no identity; a name already taken is refused before any still is asked for", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { admitCastCharacter } = await import("../../lib/castCharacter");
    const failing = fakeFlux2({ failTool: "image" });
    const total = Number((await admitCastCharacter(base({ name: "Otto", quoteOnly: true }), OWNER, options(), { flux2: failing.run })).body.estimatedCredits);
    const before = await identitiesCount();
    const refused = await admitCastCharacter(base({ name: "Otto", characterId: uid("char"), maxCredits: total }), OWNER, options(), { flux2: failing.run });
    expect(refused).toMatchObject({ status: 502, body: { error: expect.stringMatching(/Nothing billed|Refused/), spent: 0 } });
    expect(await identitiesCount()).toBe(before);
    /* A name that is taken (an identity of this workspace): refused on the quote as on the press. */
    const fake = fakeFlux2();
    const ok = await admitCastCharacter(base({ name: "Pia", characterId: uid("char"), maxCredits: total }), OWNER, options(), { flux2: fake.run });
    expect(ok.status).toBe(200);
    fake.calls.length = 0;
    expect(await admitCastCharacter(base({ name: "pia", quoteOnly: true }), OWNER, options(), { flux2: fake.run })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/already an identity/) } });
    expect(await admitCastCharacter(base({ name: "Pia", characterId: uid("char"), maxCredits: total }), OWNER, options(), { flux2: fake.run })).toMatchObject({ status: 409 });
    expect(fake.calls).toEqual([]);
    /* Bad words are refused plainly. */
    for (const bad of [{ name: "" }, { name: "9lives" }, { name: "Image1" }, { description: "" }, { description: "x".repeat(801) }, { look: "y".repeat(301) }, { engine: "midjourney" }, { model: "flux-3-image" }, { projectId: "../x" }, { draftId: "a b" }, { characterId: "short" }]) {
      expect((await admitCastCharacter(base({ ...bad, quoteOnly: true }), OWNER, options(), { flux2: fake.run })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(fake.calls).toEqual([]);
  });
});

test("Nano Banana Pro is the other engine: the views are made from the front still as a reference, one price, and FLUX.2 is never called", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { admitCastCharacter, CAST_STILLS } = await import("../../lib/castCharacter");
    const { db } = await import("../../lib/db");
    const { storeImageBytes } = await import("../../lib/storage");
    const flux = fakeFlux2();
    const sent: { quote: boolean; references: unknown; maxCredits?: unknown; ratio: unknown; model: unknown }[] = [];
    const seams = {
      flux2: flux.run,
      quoteGenerate: async (input: Record<string, unknown>) => { sent.push({ quote: true, references: input.references, ratio: input.ratio, model: input.model }); return (await import("../../lib/admissionSupport")).admissionReply({ estimatedCredits: 3, price: 3, unit: "cr" }); },
      generate: async (input: Record<string, unknown>) => {
        sent.push({ quote: false, references: input.references, maxCredits: input.maxCredits, ratio: input.ratio, model: input.model });
        const genId = uid("gen");
        await db().execute({ sql: "INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,deleted,created_by,project_id,stored_url,bytes) VALUES(?,?,?,?,?,1,1,'image',0,'owner',NULL,?,?)", args: [genId, String(input.model), String(input.prompt), "{}", "succeeded", `/stored/${genId}.png`, PNG.length] });
        await storeImageBytes(genId, PNG);
        files.push(path.join(process.cwd(), ".data", "generations", `${genId}.png`));
        return (await import("../../lib/admissionSupport")).admissionReply({ id: genId, status: "running", estimatedCredits: 3 });
      },
    };
    const quote = await admitCastCharacter(base({ name: "Quill", engine: "nano-banana-pro", quoteOnly: true }), OWNER, options(), seams);
    expect(quote.body).toMatchObject({ estimatedCredits: 3 * CAST_STILLS, upTo: true });
    expect(JSON.stringify(quote.body)).not.toMatch(/nano|banana|gemini|flux/i);
    const reply = await admitCastCharacter(base({ name: "Quill", engine: "nano-banana-pro", characterId: uid("char"), maxCredits: 3 * CAST_STILLS }), OWNER, options(), seams);
    expect(reply.body).toMatchObject({ status: "done", made: CAST_STILLS, spent: 3 * CAST_STILLS });
    expect(flux.calls).toEqual([]);
    const runs = sent.filter((s) => !s.quote);
    expect(runs).toHaveLength(CAST_STILLS);
    expect(runs[0].references).toBeUndefined();
    const frontId = (reply.body.stills as { takeId: string }[])[0].takeId;
    expect(runs.slice(1).every((r) => JSON.stringify(r.references) === JSON.stringify([{ genId: frontId, role: "reference_image" }]))).toBe(true);
    expect(runs.every((r) => r.ratio === "3:4" && r.maxCredits === 3)).toBe(true);
    expect((await admitCastCharacter(base({ name: "Quill2", engine: "nano-banana-pro", quoteOnly: true, detail: true }), OWNER, options(), seams)).body).toMatchObject({ engine: "nano-banana-pro" });
  });
});

test("auto picks FLUX.2 where it and its identity tool are on, else Nano Banana Pro; FLUX.2 asked for by name where it is off is refused", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { admitCastCharacter } = await import("../../lib/castCharacter");
    const { admissionReply } = await import("../../lib/admissionSupport");
    const flux = fakeFlux2();
    const seams = { flux2: flux.run, quoteGenerate: async () => admissionReply({ estimatedCredits: 3, price: 3, unit: "cr" }) };
    expect((await admitCastCharacter(base({ name: "Auto1", quoteOnly: true, detail: true }), OWNER, options(), seams)).body.engine).toBe("flux2");
    delete process.env.BFL_IDENTITY_ENABLED;
    expect((await admitCastCharacter(base({ name: "Auto2", quoteOnly: true, detail: true }), OWNER, options(), seams)).body.engine).toBe("nano-banana-pro");
    expect(await admitCastCharacter(base({ name: "Auto3", engine: "flux2", quoteOnly: true }), OWNER, options(), seams)).toMatchObject({ status: 400 });
  });
});

test("the gate: off, the tool is simply not here (404, nothing read or asked); it is not offered where FLUX.2 is off, and a customer workspace is off until it is listed", async () => {
  const { admitCastCharacter, castCharacterTools } = await import("../../lib/castCharacter");
  const fake = fakeFlux2();
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    expect((await castCharacterTools()).map((t) => t.id)).toEqual(["cast_character"]);
    delete process.env.BFL_ENABLED;
    expect(await castCharacterTools()).toEqual([]);
    expect(await admitCastCharacter(base({ quoteOnly: true }), OWNER, options(), { flux2: fake.run })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
  });
  process.env.BFL_ENABLED = "1";
  await asTenant(tenant("ws_customer_cast"), OWNER, async () => {
    expect(await castCharacterTools()).toEqual([]);
    expect((await admitCastCharacter(base({ quoteOnly: true }), OWNER, options(), { flux2: fake.run })).status).toBe(404);
  });
  expect(fake.calls).toEqual([]);
});

test("tenant isolation: a name, a character id and an identity belong to one workspace; another workspace neither collides with them nor finds them", async () => {
  const { admitCastCharacter, castCharacterStatus } = await import("../../lib/castCharacter");
  const fake = fakeFlux2();
  const seams = { flux2: fake.run };
  const characterId = uid("shared");
  let total = 0;
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    total = Number((await admitCastCharacter(base({ name: "Zed", quoteOnly: true }), OWNER, options(), seams)).body.estimatedCredits);
    expect((await admitCastCharacter(base({ name: "Zed", characterId, maxCredits: total }), OWNER, options(), seams)).status).toBe(200);
    expect(await castCharacterStatus(characterId)).toMatchObject({ done: true });
  });
  /* The same name and sheet id in another workspace that has the engine on (a listed one): its own, from nothing. */
  const { platformDb: platform, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platform().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, 'x') ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: ["ws_listed_cast"] })] }).catch(() => undefined);
  await asTenant(tenant("ws_listed_cast"), OWNER, async () => {
    expect(await castCharacterStatus(characterId)).toBeNull();
    const before = fake.made();
    const reply = await admitCastCharacter(base({ name: "Zed", characterId, maxCredits: total }), OWNER, options(), seams);
    expect(reply.status).toBe(200);
    expect(fake.made() - before).toBe(8);
  });
});

test("an outside agent can run it over MCP: it is listed where the tool is on, one POST to the route for the price, never a maxCredits, and it says a person approves", async () => {
  await asTenant(tenant("ws_legacy"), OWNER, async () => {
    const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
    const listed = (await directEngineMcpTools()).map((t) => t.name);
    expect(listed).toContain("cast_character");
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const call = (async (path: string, init: { body?: Record<string, unknown> } = {}) => {
      calls.push({ path, body: init.body ?? {} });
      if (path === "/api/cast-character") return { estimatedCredits: 14, price: 14, unit: "cr", stills: 8, upTo: true };
      throw new Error("This token prepares jobs and cannot file.");
    }) as never;
    const text = await runDirectEngineTool("cast_character", { name: "Mira", description: "a tall woman with short silver hair", draft_id: "d1" }, call);
    expect(text).toContain("14 cr");
    expect(text).toMatch(/needs a person's approval/i);
    expect(calls[0]).toEqual({ path: "/api/cast-character", body: { name: "Mira", description: "a tall woman with short silver hair", draftId: "d1", quoteOnly: true } });
    expect(calls.some((c) => "maxCredits" in c.body)).toBe(false);
    await expect(runDirectEngineTool("cast_character", { name: "Mira", description: "x", max_credits: 5 }, call)).rejects.toThrow(/only a person approves/i);
    delete process.env.BFL_ENABLED;
    expect((await directEngineMcpTools()).map((t) => t.name)).not.toContain("cast_character");
    await expect(runDirectEngineTool("cast_character", { name: "Mira", description: "x" }, call)).rejects.toThrow(/no such tool/i);
  });
});

test("the tool is declared as rule 11 asks, and its words are the sheet's: eight angles, a 3:4 size that is a multiple of 16, no engine in the angle prompts", async () => {
  const { CAST_CHARACTER_TOOL, CAST_ANGLES, CAST_SIZE, anglePrompt } = await import("../../lib/castCharacter");
  expect(CAST_CHARACTER_TOOL).toMatchObject({ id: "cast_character", route: "/api/cast-character", who: "prepare: anyone; approve: a person" });
  expect(CAST_ANGLES.map((a) => a.id)).toEqual(["front", "three-quarter-left", "profile-left", "back", "three-quarter-right", "profile-right", "face", "walking"]);
  expect(CAST_SIZE.width % 16 === 0 && CAST_SIZE.height % 16 === 0 && CAST_SIZE.width * 4 === CAST_SIZE.height * 3).toBe(true);
  for (const angle of CAST_ANGLES) expect(anglePrompt("Mira: a tall woman", angle, true)).not.toMatch(/flux|bfl|nano|banana|gemini/i);
  expect(anglePrompt("Mira: a tall woman", CAST_ANGLES[0], false)).not.toMatch(/same character as the reference/);
  expect(anglePrompt("Mira: a tall woman", CAST_ANGLES[1], true)).toMatch(/same character as the reference/);
});
