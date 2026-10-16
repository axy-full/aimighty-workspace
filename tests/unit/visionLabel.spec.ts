import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, AdmissionExecution } from "../../lib/admissionTypes";

/**
 * The label check (lib/vision.ts, lib/labelDiff.ts, lib/visionLabel.ts). Mocked: every adapter call is a function this file hands the workflow (the internal seams `admitLabelCheck` and
 * `(none)`, which the public route and the cron do not offer), or the in-process fixture under ENGINE_MOCK=1; no request leaves this process and no
 * provider is paid. Local temporary databases only. Neutral sample names.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-vision-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.VISION_LABEL_CHECK_ENABLED; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] };
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;
const made: string[] = [];
test.afterAll(async () => { for (const f of made) await unlink(f).catch(() => {}); });
async function asTenant(ws: TenantWorkspace, fn: () => Promise<void>): Promise<void> {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(ws, fn, OWNER as never);
}
const deferred: (() => Promise<unknown>)[] = [];
const options = (): AdmissionExecution => ({ defer: async (work) => { deferred.push(work); } });

async function project(id: string) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [id, id] });
}
/** An image upload of this workspace holding `bytes` (the fixture reads a picture that begins MOCKTEXT: as showing the text after it). */
async function frame(label: string, text: string | null): Promise<{ id: string }> {
  const { db, ready } = await import("../../lib/db");
  const { storeUpload } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  const bytes = Buffer.from(text == null ? `plain-picture-${id}` : `MOCKTEXT:${text}`);
  await storeUpload(id, "png", bytes, "image/png");
  made.push(path.join(process.cwd(), ".data", "uploads", `${id}.png`));
  await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,width,height,stored_url,created_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, "image/png", "png", bytes.length, "x", 640, 360, `uploads/${id}.png`, Date.now(), "image"] });
  return { id };
}
/** A take of this workspace: an image take with its stored picture, or a video take (no picture the server can read). */
async function take(label: string, kind: "image" | "video", text: string | null = null, projectId: string | null = null, createdBy = "u_test"): Promise<string> {
  const { db, ready } = await import("../../lib/db");
  const { storeImageBytes } = await import("../../lib/storage");
  await ready();
  const id = uid(label);
  let stored: string | null = null;
  if (kind === "image") {
    stored = (await storeImageBytes(id, Buffer.from(text == null ? `plain-picture-${id}` : `MOCKTEXT:${text}`))).url;
    made.push(path.join(process.cwd(), ".data", "generations", `${id}.png`));
  }
  await db().execute({
    sql: "INSERT INTO generations (id, project_id, kind, model, prompt, params, status, created_by, created_at, updated_at, provider, task, title, stored_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    args: [id, projectId, kind, kind === "image" ? "gemini-3.1-flash-image" : "seedance", "A can of cola", JSON.stringify({ job: "other" }), "succeeded", createdBy, Date.now(), Date.now(), "google", "generate", "A can", stored],
  });
  return id;
}
async function meterRows() {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return (await platformDb().execute("SELECT id,workspace_id,status,engine_cost_usd,overrun_usd,billed_credits,paid_by_platform FROM meter_events WHERE engine='vision' ORDER BY created_at, id")).rows;
}
async function row(id: string) {
  const { db } = await import("../../lib/db");
  const r = (await db().execute({ sql: "SELECT status,stored_url,deleted,json_extract(params,'$.labelCheck') AS lc, params FROM generations WHERE id=?", args: [id] })).rows[0] as unknown as Record<string, unknown>;
  return { status: r.status, stored_url: r.stored_url, deleted: r.deleted, check: r.lc ? (JSON.parse(String(r.lc)) as import("../../lib/visionLabel").LabelCheckRecord) : null, params: JSON.parse(String(r.params)) as Record<string, unknown> };
}
async function admit(input: Record<string, unknown>, seams: import("../../lib/visionLabel").LabelCheckSeams = {}) {
  const { admitLabelCheck } = await import("../../lib/visionLabel");
  return admitLabelCheck(input, OWNER, options(), seams);
}
/** The same request made by another person: the admission asks that the request's own scope names its actor, so it runs in a scope of its own. */
async function admitAs(actor: AdmissionActor, input: Record<string, unknown>, seams: import("../../lib/visionLabel").LabelCheckSeams = {}, ws: TenantWorkspace = house()) {
  const { admitLabelCheck } = await import("../../lib/visionLabel");
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, () => admitLabelCheck(input, actor, options(), seams), actor as never);
}
const person = (id: string, role: "admin" | "member" = "member", owner = false): AdmissionActor => ({ user: { id, email: `${id}@example.invalid`, name: id, role, owner, disabled: false, createdAt: 0, lastSeen: null } as AdmissionActor["user"] });
const approved = { maxCredits: 100000 };
const PRICE = 0.0015;
const reads = (text: string) => ({ detect: async () => ({ text, words: text ? [{ text: "ACME", box: [1, 2, 3, 4] as [number, number, number, number] }] : [] }) });

test("the price is Google's published one, verified 16 Oct 2026: one image at $0.0015, through the margin table", async () => {
  const { VISION_RATES } = await import("../../lib/vendorRates");
  expect(VISION_RATES.textDetectionUsdPerImage).toBe(0.0015);
  expect(readFileSync("lib/vendorRates.ts", "utf8")).toMatch(/Verified against Google's pricing\s+\* page \(cloud\.google\.com\/vision\/pricing\), 16 Oct 2026; confirm against the first invoice[\s\S]{0,900}export const VISION_RATES/);
});

test("off: with the switch off, or a workspace not on the list, there is no tool and nothing is metered; the house and a listed workspace are offered the check", async () => {
  const { labelCheckTools } = await import("../../lib/visionLabel");
  await asTenant(house(), async () => {
    const t = await take("t_off", "image", "ACME");
    const before = (await meterRows()).length;
    delete process.env.VISION_LABEL_CHECK_ENABLED;
    expect(await labelCheckTools()).toEqual([]);
    expect(await admit({ takeId: t, expected: "ACME", ...approved })).toMatchObject({ status: 404, body: { error: "There is no such tool here." } });
    for (const odd of ["0", "true", "yes", ""]) { process.env.VISION_LABEL_CHECK_ENABLED = odd; expect(await labelCheckTools(), odd).toEqual([]); }
    process.env.VISION_LABEL_CHECK_ENABLED = "1";
    const on = await labelCheckTools();
    expect(on.map((x) => x.id)).toEqual(["label_check"]);
    expect(on.every((x) => x.provider === "google" && x.route === "/api/label-check" && x.models.join() === "vision-text-detection")).toBe(true);
    expect((await meterRows()).length).toBe(before);
    expect((await row(t)).check).toBeNull();
  });
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(tenant("ws_vision_unlisted"), async () => {
    expect(await labelCheckTools()).toEqual([]);
    expect(await admit({ takeId: "x", expected: "ACME", quoteOnly: true })).toMatchObject({ status: 404 });
  });
});

test("the quote, and every input refused in words before anything is reserved; a quote writes nothing", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const t = await take("t_quote", "image", "ACME");
    const v = await take("t_quote_video", "video");
    const f = await frame("f_quote", "ACME");
    const before = (await meterRows()).length;
    const q = await admit({ takeId: t, expected: "ACME", quoteOnly: true });
    expect(q).toMatchObject({ status: 200, body: { unit: "usd", estimatedCredits: 1, mode: "whole", images: 1, rules: { unicode: "nfc", case: "exact", whitespace: "exact" } } });
    expect(Number(q.body.price)).toBeCloseTo(PRICE, 6);
    expect(await admit({ takeId: v, frameUploadId: f.id, expected: "ACME", mode: "contains", rules: { case: "fold" }, quoteOnly: true })).toMatchObject({ status: 200, body: { mode: "contains", rules: { unicode: "nfc", case: "fold", whitespace: "exact" } } });
    const refused: [Record<string, unknown>, number, RegExp][] = [
      [{ expected: "ACME" }, 400, /Pick the take/],
      [{ takeId: "../x", expected: "ACME" }, 400, /Pick the take/],
      [{ takeId: t }, 400, /Write the text the label must carry/],
      [{ takeId: t, expected: "   " }, 400, /Write the text the label must carry/],
      [{ takeId: t, expected: 5 }, 400, /Write the text/],
      [{ takeId: t, expected: "x".repeat(1001) }, 400, /up to 1,000 characters/],
      [{ takeId: t, expected: "ACME", mode: "fuzzy" }, 400, /mode is whole/],
      [{ takeId: t, expected: "ACME", rules: { case: "ignore" } }, 400, /case is exact/],
      [{ takeId: t, expected: "ACME", rules: { accents: "strip" } }, 400, /no rule called accents/],
      [{ takeId: "gen_not_here", expected: "ACME" }, 404, /not in this workspace/],
      [{ takeId: v, expected: "ACME" }, 400, /checked on a frame of it/],
      [{ takeId: t, frameUploadId: "../x", expected: "ACME" }, 400, /frame is not valid/],
      [{ takeId: t, frameUploadId: "up_not_here", expected: "ACME" }, 404, /image uploads/],
    ];
    for (const [input, status, words] of refused) {
      const reply = await admit({ ...input, quoteOnly: true });
      expect(reply.status, JSON.stringify(input)).toBe(status);
      expect(String(reply.body.error), JSON.stringify(input)).toMatch(words);
    }
    expect((await meterRows()).length).toBe(before);
    expect((await row(t)).check).toBeNull();
  });
});

test("approval: a price that is not approved, or is above the approved amount, runs and writes nothing", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const t = await take("t_appr", "image", "ACME");
    const before = (await meterRows()).length;
    for (const bad of [{}, { maxCredits: 0 }, { maxCredits: "5" }, { maxCredits: 1.5 }]) expect((await admit({ takeId: t, expected: "ACME", ...bad }, reads("ACME"))).status, JSON.stringify(bad)).toBe(409);
    expect((await meterRows()).length).toBe(before);
    expect((await row(t)).check).toBeNull();
  });
});

test("a correct label passes; the check bills the quote once, writes its result on the take, and the take itself is untouched", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const projectId = uid("prod");
    await project(projectId);
    const t = await take("t_ok", "image", "ACME COLA 330 ml", projectId);
    const was = await row(t);
    const before = (await meterRows()).length;
    const reply = await admit({ takeId: t, expected: "ACME COLA 330 ml", ...approved }, reads("ACME COLA 330 ml\n"));
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ ok: true, takeId: t, verdict: "match", flagged: false, kept: true, distance: 0, estimatedCredits: 1 });
    const after = await row(t);
    expect(after.check).toMatchObject({ v: 1, verdict: "match", flagged: false, mode: "whole", expected: "ACME COLA 330 ml", detected: "ACME COLA 330 ml", distance: 0, source: { kind: "take", id: t } });
    expect(after.check!.words).toEqual([{ text: "ACME", box: [1, 2, 3, 4] }]);
    /* The take is the same take: nothing but the result was added. */
    expect([after.status, after.stored_url, after.deleted]).toEqual([was.status, was.stored_url, was.deleted]);
    const { labelCheck: _lc, ...rest } = after.params;
    void _lc;
    expect(rest).toEqual(was.params);
    const rows = (await meterRows()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded" });
    expect(Number(rows[0].engine_cost_usd)).toBeCloseTo(PRICE, 6);
    expect(Number(rows[0].billed_credits ?? 0)).toBe(0);
  });
});

test("one letter wrong, and no text at all, flag the take for a person with the difference; neither blocks, hides or changes it", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const t = await take("t_bad", "image", "ACME COIA");
    const was = await row(t);
    const wrong = await admit({ takeId: t, expected: "ACME COLA", ...approved }, reads("ACME COIA"));
    expect(wrong.body).toMatchObject({ verdict: "mismatch", flagged: true, distance: 2, detected: "ACME COIA" });
    const rec = (await row(t)).check!;
    expect(rec).toMatchObject({ verdict: "mismatch", flagged: true, distance: 2 });
    expect(rec.ops.filter((o) => o.op === "remove").map((o) => o.text).join("")).toBe("L");
    expect(rec.ops.filter((o) => o.op === "add").map((o) => o.text).join("")).toBe("I");
    expect(rec.words.length).toBeGreaterThan(0);
    /* Run again, on the same take: the latest result stands. */
    const missing = await admit({ takeId: t, expected: "ACME COLA", ...approved }, reads(""));
    expect(missing.body).toMatchObject({ verdict: "missing", flagged: true, detected: "" });
    expect((await row(t)).check).toMatchObject({ verdict: "missing", flagged: true, detected: "", words: [] });
    const fixed = await admit({ takeId: t, expected: "ACME COIA", ...approved }, reads("ACME COIA"));
    expect(fixed.body).toMatchObject({ verdict: "match", flagged: false });
    /* Never blocked: the take is as it was, still usable, still visible. */
    const after = await row(t);
    expect([after.status, after.stored_url, after.deleted]).toEqual([was.status, was.stored_url, was.deleted]);
  });
});

test("the rules a caller chooses are applied and recorded; the strict default is recorded when none is given", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const t = await take("t_rules", "image", "x");
    const strict = await admit({ takeId: t, expected: "Acme Cola", ...approved }, reads("ACME  COLA"));
    expect(strict.body).toMatchObject({ verdict: "mismatch", rules: { unicode: "nfc", case: "exact", whitespace: "exact" } });
    const loose = await admit({ takeId: t, expected: "Acme Cola", rules: { case: "fold", whitespace: "collapse" }, ...approved }, reads("ACME  COLA"));
    expect(loose.body).toMatchObject({ verdict: "match", rules: { unicode: "nfc", case: "fold", whitespace: "collapse" } });
    expect((await row(t)).check!.rules).toEqual({ unicode: "nfc", case: "fold", whitespace: "collapse" });
    const inside = await admit({ takeId: t, expected: "COLA", mode: "contains", ...approved }, reads("NEW\nACME COLA\nOK"));
    expect(inside.body).toMatchObject({ verdict: "match", mode: "contains" });
  });
});

test("a video is checked on a frame: the frame's text is read, the result is kept on the video take, and it names the frame; a frame of another kind is refused", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const v = await take("t_video", "video");
    const f = await frame("f_video", "ACME COLA");
    const reply = await admit({ takeId: v, frameUploadId: f.id, expected: "ACME COLA", ...approved });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect((await row(v)).check).toMatchObject({ verdict: "match", flagged: false, source: { kind: "upload", id: f.id } });
    expect((await row(v)).status).toBe("succeeded");
    /* A frame with no text in it is missing, billed (Google read the picture). */
    const blank = await frame("f_blank", null);
    const before = (await meterRows()).length;
    expect((await admit({ takeId: v, frameUploadId: blank.id, expected: "ACME COLA", ...approved })).body).toMatchObject({ verdict: "missing", flagged: true });
    expect(Number((await meterRows()).slice(before)[0].engine_cost_usd)).toBeCloseTo(PRICE, 6);
  });
});

test("who may check a take: a private board's take is as absent as an unknown one; another member's take is readable but not changeable; its maker, an admin and a run for its maker may; nothing is read, held or written for anyone refused", async () => {
  const { db } = await import("../../lib/db");
  const draft = await import("../../lib/draftProject");
  const { newProject } = await import("../../lib/workbench/studio");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const { requireTenant } = await import("../../lib/tenant");
    await workbenchReady();
    await rigAgentReady();

    const draftId = uid("d");
    const board = draft.mappedId("prj_wb_", requireTenant().id, "u_owner", draftId);
    await db().execute({ sql: "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES(?,?,0)", args: [board, "Private board"] });
    await db().execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,0)", args: [`u_owner:${draftId}`, "u_owner", draftId, draftId, JSON.stringify({ ...newProject(draftId), id: draftId, productionProjectId: board })] });

    const open = uid("prod");
    await project(open);
    const secret = await take("t_priv", "image", "SECRET LABEL", board, "u_owner");
    const theirs = await take("t_theirs", "image", "ACME", open, "u_owner");
    const calls: string[] = [];
    const spy = { detect: async () => { calls.push("detect"); return { text: "ACME", words: [] }; } };
    const meters = async () => (await meterRows()).length;
    const before = await meters();
    const mate = person("u_mate"), maker = person("u_owner"), admin = person("u_admin", "admin", true);
    /* A member, an admin and a quote: the private board's take is not there, whatever they ask. */
    for (const [who, label] of [[mate, "member"], [admin, "admin"]] as const) {
      for (const extra of [{ quoteOnly: true }, approved]) {
        const reply = await admitAs(who, { takeId: secret, expected: "ACME", ...extra }, spy);
        expect(reply, `${label} ${JSON.stringify(extra)}`).toMatchObject({ status: 404, body: { error: "That take is not in this workspace." } });
      }
      /* The same answer as a take that does not exist. */
      expect((await admitAs(who, { takeId: "gen_not_here", expected: "ACME", ...approved }, spy)).body).toEqual((await admitAs(who, { takeId: secret, expected: "ACME", ...approved }, spy)).body);
    }
    expect(calls).toEqual([]);
    expect(await meters()).toBe(before);
    expect((await row(secret)).check).toBeNull();
    /* Another member's take in an ordinary board: readable, not changeable: refused in the words every route uses, before anything is read or held. */
    for (const extra of [{ quoteOnly: true }, approved]) {
      expect(await admitAs(mate, { takeId: theirs, expected: "ACME", ...extra }, spy), JSON.stringify(extra)).toMatchObject({ status: 403, body: { error: expect.stringContaining("someone else's work") } });
    }
    expect(calls).toEqual([]);
    expect(await meters()).toBe(before);
    expect((await row(theirs)).check).toBeNull();
    /* Its maker, and an admin, may; the result lands on the take. */
    expect((await admitAs(maker, { takeId: theirs, expected: "ACME", ...approved }, spy)).status).toBe(200);
    expect((await admitAs(admin, { takeId: theirs, expected: "ACME", ...approved }, spy)).status).toBe(200);
    expect(calls).toEqual(["detect", "detect"]);
    expect((await row(theirs)).check).toMatchObject({ verdict: "match" });
    /* The board's owner checks a take of their own board. */
    expect((await admitAs(maker, { takeId: secret, expected: "SECRET LABEL", ...approved }, { detect: async () => ({ text: "SECRET LABEL", words: [] }) })).status).toBe(200);
    expect((await row(secret)).check).toMatchObject({ verdict: "match" });
    /* A frame of another person's private upload is not openable either. */
    /* An Atomik run acts as the person who started it, as a member; a run that names nobody, and the server's own pass, have no person and are refused. */
    const run = async (owner: string) => { const id = uid("run"); await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: [id, "prod_x", "draft_x", owner, uid("req"), "goal", "auto", "finished"] }); return person(`agent:${id}`); };
    const forMate = await run("u_mate"), forMaker = await run("u_owner");
    calls.length = 0;
    expect(await admitAs(forMate, { takeId: secret, expected: "ACME", ...approved }, spy)).toMatchObject({ status: 404 });
    expect(await admitAs(forMate, { takeId: theirs, expected: "ACME", ...approved }, spy)).toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
    expect((await admitAs(forMaker, { takeId: theirs, expected: "ACME", ...approved }, spy)).status).toBe(200);
    expect(calls).toEqual(["detect"]);
    for (const nobody of [person("agent:run_that_does_not_exist"), person("server")]) {
      expect(await admitAs(nobody, { takeId: theirs, expected: "ACME", ...approved }, spy), nobody.user.id).toMatchObject({ status: 403, body: { error: "This check needs a person behind it." } });
    }
    expect(calls).toEqual(["detect"]);
  });
});

test("the cost approval rule: with a cap per shot, a member's check on a take of a full shot is refused (403, needs an admin) for a quote and a press, nothing read, held or written; an admin, a shot with room and a take on no shot go through", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { invalidateSettings } = await import("../../lib/settings");
  const { db } = await import("../../lib/db");
  await platformReady();
  const id = "ws_vision_shotcap";
  await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`] });
  await grantCredits(id, 500, "Test", "owner", "manual");
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const member = person("u_member");
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [id] })] });
    process.env.VISION_LABEL_CHECK_ENABLED = "1";
    const ws = (await getWorkspace(id))!;
    await asTenant(ws, async () => {
      const setting = async (rule: string, cap: number) => {
        await db().execute({ sql: "INSERT INTO settings(key,value,updated_at) VALUES('approvalRule',?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [rule] });
        await db().execute({ sql: "INSERT INTO settings(key,value,updated_at) VALUES('shotCapCredits',?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [String(cap)] });
        invalidateSettings();
      };
      const prod = uid("prod"), tight = uid("shot_tight"), roomy = uid("shot_roomy");
      await project(prod);
      for (const [shot, code] of [[tight, "S2"], [roomy, "S3"]] as const) await db().execute({ sql: "INSERT INTO shots(id,project_id,code,title,description,setup,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)", args: [shot, prod, code, "t", "", "{}"] });
      const onShot = async (label: string, shot: string | null) => { const t = await take(label, "image", "ACME", prod, "u_member"); await db().execute({ sql: "UPDATE generations SET shot_id=? WHERE id=?", args: [shot, t] }); return t; };
      const stuck = await onShot("t_tight", tight), free = await onShot("t_roomy", roomy), loose = await onShot("t_loose", null);
      const calls: string[] = [];
      const spy = { detect: async () => { calls.push("detect"); return { text: "ACME", words: [] }; } };
      try {
        /* The check is 1 cr; a cap of 1 cr a shot holds the first and nothing after it. */
        await setting("cap", 1);
        const before = (await meterRows()).filter((r) => r.workspace_id === id).length;
        expect((await admitAs(member, { takeId: stuck, expected: "ACME", ...approved }, spy, ws)).status).toBe(200);
        const after = (await meterRows()).filter((r) => r.workspace_id === id).length;
        expect(after).toBe(before + 1);
        for (const extra of [{ quoteOnly: true }, approved]) {
          const reply = await admitAs(member, { takeId: stuck, expected: "ACME", ...extra }, spy, ws);
          expect(reply, JSON.stringify(extra)).toMatchObject({ status: 403, body: { needsAdmin: true, error: expect.stringContaining("S2") } });
          expect(String(reply.body.error)).toMatch(/An admin has to press this one/);
        }
        expect(calls).toEqual(["detect"]);
        expect((await meterRows()).filter((r) => r.workspace_id === id).length).toBe(after);
        /* Only an admin's own press waives the cap: an admin's token, an Atomik Auto step and an agent run for an admin are machines, held like a member. */
        const adminToken = { ...person("u_admin_tok", "admin", true), token: { id: "tok_admin", name: "agent", scope: "render" as const, capUsd: null } } as AdmissionActor;
        expect(await admitAs(adminToken, { takeId: stuck, expected: "ACME", quoteOnly: true }, spy, ws)).toMatchObject({ status: 403, body: { needsAdmin: true } });
        const { admitLabelCheck } = await import("../../lib/visionLabel");
        const { runInTenant } = await import("../../lib/tenant");
        const adminUser = person("u_admin", "admin", true);
        expect(await runInTenant(ws, () => admitLabelCheck({ takeId: stuck, expected: "ACME", quoteOnly: true }, adminUser, { ...options(), run: { auto: true } } as never, spy), adminUser as never)).toMatchObject({ status: 403, body: { needsAdmin: true } });
        const { rigAgentReady } = await import("../../lib/workbench/rig-agent-store");
        await rigAgentReady();
        const runId = uid("run");
        await db().execute({ sql: "INSERT INTO rig_agent_runs(id,production_id,draft_id,owner,request_id,goal,model,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)", args: [runId, "prod_x", "draft_x", "u_member", uid("req"), "goal", "auto", "finished"] });
        expect(await admitAs(person(`agent:${runId}`, "admin", true), { takeId: stuck, expected: "ACME", quoteOnly: true }, spy, ws)).toMatchObject({ status: 403, body: { needsAdmin: true } });
        /* An admin goes through; a take on a shot with room, or on no shot, is not held. */
        expect((await admitAs(person("u_admin", "admin", true), { takeId: stuck, expected: "ACME", ...approved }, spy, ws)).status).toBe(200);
        expect((await admitAs(member, { takeId: free, expected: "ACME", ...approved }, spy, ws)).status).toBe(200);
        expect((await admitAs(member, { takeId: loose, expected: "ACME", ...approved }, spy, ws)).status).toBe(200);
        await setting("cap", 10_000);
        expect((await admitAs(member, { takeId: stuck, expected: "ACME", quoteOnly: true }, spy, ws)).status).toBe(200);
        await setting("off", 1);
        expect((await admitAs(member, { takeId: stuck, expected: "ACME", quoteOnly: true }, spy, ws)).status).toBe(200);
      } finally {
        await db().execute("DELETE FROM settings WHERE key IN ('approvalRule','shotCapCredits')");
        invalidateSettings();
      }
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("a reservation the process never settled is settled at nothing by the cron stage, which frees its hold and sends nothing; young ones and other engines' are left alone", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const { reserveGenerationSpend } = await import("../../lib/generationRequests");
    const { recoverLabelChecks, LABEL_CHECK_STALE_MS } = await import("../../lib/visionLabel");
    const lost = uid("vlc_lost"), other = uid("sarvam_other");
    await reserveGenerationSpend({ id: lost, kind: "image", engine: "vision", model: "vision-text-detection", status: "running", engineCostUsd: PRICE, createdBy: "owner" });
    await reserveGenerationSpend({ id: other, kind: "text", engine: "sarvam", model: "sarvam-translate:v1", status: "running", engineCostUsd: 0.01, createdBy: "owner" });
    expect((await meterRows()).find((r) => r.id === lost)).toMatchObject({ status: "running" });
    expect((await recoverLabelChecks({ limit: 50 })).attempted).toBe(0);
    const done = await recoverLabelChecks({ limit: 50 }, () => Date.now() + LABEL_CHECK_STALE_MS + 60_000);
    expect(done).toMatchObject({ failed: 0 });
    expect(done.attempted).toBeGreaterThanOrEqual(1);
    const settled = (await meterRows()).find((r) => r.id === lost)!;
    expect(settled).toMatchObject({ status: "failed" });
    expect(Number(settled.engine_cost_usd)).toBe(0);
    expect(Number(settled.billed_credits ?? 0)).toBe(0);
    /* Whether Google read the picture is unknown, and the ledger line says so for the admin desk to reconcile. */
    const { platformDb: pdb } = await import("../../lib/platform");
    const outcome = JSON.parse(String((await pdb().execute({ sql: "SELECT provider_outcome FROM meter_events WHERE id=?", args: [lost] })).rows[0].provider_outcome));
    expect(outcome).toMatchObject({ provider: "google", stage: "run", code: "no_answer", billing: { state: "unknown" } });
    /* Another engine's reservation is not this stage's. */
    const { platformDb } = await import("../../lib/platform");
    expect((await platformDb().execute({ sql: "SELECT status FROM meter_events WHERE id=?", args: [other] })).rows[0].status).toBe("running");
    /* A second pass has nothing left to do. */
    expect((await recoverLabelChecks({ limit: 50 }, () => Date.now() + LABEL_CHECK_STALE_MS + 60_000)).attempted).toBe(0);
  });
  expect(readFileSync("lib/jobs.ts", "utf8")).toContain('(await import("./visionLabel")).recoverLabelChecks(');
});

test("a failure bills nothing and changes nothing: a refusal, a dropped connection and a bad picture say 'Nothing was billed', settle at 0, and leave the take with no result", async () => {
  const { VisionError } = await import("../../lib/vision");
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const t = await take("t_fail", "image", "ACME");
    const before = (await meterRows()).length;
    const fails = async (error: Error) => admit({ takeId: t, expected: "ACME", ...approved }, { detect: async () => { throw error; } });
    const refused = await fails(new VisionError("Google refused the request: quota", 429, true));
    expect(refused).toMatchObject({ status: 429, body: { charged: 0 } });
    expect(String(refused.body.error)).toMatch(/Nothing was billed/);
    const dropped = await fails(new VisionError("Google did not answer."));
    expect(dropped.status).toBe(502);
    expect(String(dropped.body.error)).toMatch(/Google did not answer\. Nothing was billed/);
    const rows = (await meterRows()).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "failed" && Number(r.engine_cost_usd) === 0 && Number(r.billed_credits ?? 0) === 0)).toBe(true);
    expect((await row(t)).check).toBeNull();
    expect((await row(t)).status).toBe("succeeded");
  });
});

test("the check shown to a person is the result and nothing else: no picture id, no meter id, no figure", async () => {
  const { db } = await import("../../lib/db");
  const { rowToGeneration } = await import("../../lib/jobs");
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  await asTenant(house(), async () => {
    const t = await take("t_read", "video");
    const f = await frame("f_read", "ACME COIA");
    await admit({ takeId: t, frameUploadId: f.id, expected: "ACME COLA", ...approved });
    const raw = (await db().execute({ sql: "SELECT * FROM generations WHERE id=?", args: [t] })).rows[0];
    const read = rowToGeneration({ ...raw, project_name: null }) as unknown as { params: Record<string, unknown> };
    const shown = read.params.labelCheck as Record<string, unknown>;
    expect(Object.keys(shown).sort()).toEqual(["checkedAt", "detected", "distance", "expected", "flagged", "mode", "ops", "rules", "v", "verdict", "words"]);
    expect(JSON.stringify(shown)).not.toContain(f.id);
    expect(JSON.stringify(shown)).not.toMatch(/source|meter|vlc_|reserved|usd/i);
    expect(shown).toMatchObject({ verdict: "mismatch", flagged: true, distance: 2 });
  });
});

test("a listed customer workspace pays exactly the quote in credits, once, and a failure refunds it; at its own $0 cap it is refused 429 with nothing held, written or sent", async () => {
  const { platformReady, platformDb, grantCredits, getWorkspace } = await import("../../lib/platform");
  const { creditState } = await import("../../lib/credits");
  const { billCredits } = await import("../../lib/creditTerms");
  const { db, ready } = await import("../../lib/db");
  const { VisionError } = await import("../../lib/vision");
  await platformReady();
  const listed = "ws_vision_listed", capped = "ws_vision_cap0";
  for (const [id, cap] of [[listed, null], [capped, 0]] as const) {
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour,allowance_usd) VALUES(?,?,?,?,1,'owner',0,0,20,200,?)", args: [id, id, id, `file:${path.join(dir, id + ".db")}`, cap] });
    await grantCredits(id, 500, "Test", "owner", "manual");
  }
  const site = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify({ enginesOnWorkspaces: [listed, capped] })] });
    process.env.VISION_LABEL_CHECK_ENABLED = "1";
    await asTenant((await getWorkspace(listed))!, async () => {
      const t = await take("t_cr", "image", "ACME");
      const expected = billCredits(PRICE, "vision-text-detection");
      expect(await admit({ takeId: t, expected: "ACME", quoteOnly: true })).toMatchObject({ body: { unit: "cr", estimatedCredits: expected } });
      const start = (await creditState())!.balance;
      expect((await admit({ takeId: t, expected: "ACME", maxCredits: expected - 1 }, reads("ACME"))).status).toBe(409);
      expect((await creditState())!.balance).toBe(start);
      expect((await admit({ takeId: t, expected: "ACME", maxCredits: expected }, reads("ACME"))).status).toBe(200);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
      const mine = (await meterRows()).filter((r) => r.workspace_id === listed);
      expect(mine).toHaveLength(1);
      expect(Number(mine[0].billed_credits)).toBe(expected);
      /* A failure refunds it. */
      expect((await admit({ takeId: t, expected: "ACME", maxCredits: expected }, { detect: async () => { throw new VisionError("Google refused the request: no", 400, true); } })).status).toBe(400);
      expect((await creditState())!.balance).toBeCloseTo(start - expected, 6);
    });
    await asTenant((await getWorkspace(capped))!, async () => {
      await ready();
      const t = await take("t_cap", "image", "ACME");
      const calls: string[] = [];
      const reply = await admit({ takeId: t, expected: "ACME", ...approved }, { detect: async () => { calls.push("detect"); return { text: "ACME", words: [] }; } });
      expect(reply.status, JSON.stringify(reply.body)).toBe(429);
      expect(String(reply.body.error)).toMatch(/monthly cap on the platform's engines/);
      expect(String(reply.body.error)).not.toMatch(/\$|\d/);
      expect((await platformDb().execute({ sql: "SELECT id FROM meter_events WHERE workspace_id=?", args: [capped] })).rows).toEqual([]);
      expect(calls).toEqual([]);
      expect((await row(t)).check).toBeNull();
      expect(Number((await db().execute({ sql: "SELECT COUNT(*) AS n FROM generations WHERE id=?", args: [t] })).rows[0].n)).toBe(1);
    });
  } finally {
    if (typeof site === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [site] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("over MCP: label_check is listed only where the engine is on; Ask files a prepared job and starts nothing; Auto starts it (a check is a draft) only at or under the per-job line; the caller cannot approve", async () => {
  const { directEngineMcpTools, runDirectEngineTool } = await import("../../lib/directEngineMcp");
  const { setSetting, invalidateSettings } = await import("../../lib/settings");
  const { db, ready } = await import("../../lib/db");
  const { jobApprovalLineCredits } = await import("../../lib/approvalRule");
  const { creditUsd } = await import("../../lib/creditTerms");
  const line = jobApprovalLineCredits(creditUsd());
  const spend = async (value: string | null) => { if (value === null) await db().execute("DELETE FROM settings WHERE key='spendWithoutAsking'"); else await setSetting("spendWithoutAsking", value, "admin"); invalidateSettings(); };
  let credits = 1;
  const calls: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const call = async (p: string, init: { body?: unknown } = {}) => { const body = init.body as Record<string, unknown>; paths.push(p); calls.push(body); if (p === "/api/prepared-jobs") return { job: { id: "prep_l1" } }; return body.quoteOnly === true ? { estimatedCredits: credits, price: credits / 1000, unit: "usd" } : { verdict: "mismatch", flagged: true, distance: 2, detected: "ACME COIA" }; };
  await asTenant(house(), async () => {
    await ready();
    delete process.env.VISION_LABEL_CHECK_ENABLED;
    expect((await directEngineMcpTools()).map((x) => x.name)).not.toContain("label_check");
    await expect(runDirectEngineTool("label_check", { take_id: "t", expected: "ACME" }, call)).rejects.toThrow("There is no such tool here.");
    process.env.VISION_LABEL_CHECK_ENABLED = "1";
    expect((await directEngineMcpTools()).map((x) => x.name)).toContain("label_check");
    try {
      for (const mode of [null, "ask", "AUTO"]) {
        await spend(mode); calls.length = 0; paths.length = 0;
        const text = await runDirectEngineTool("label_check", { take_id: "gen_1", expected: "ACME COLA" }, call);
        expect(text, String(mode)).toMatch(/^Priced and prepared, not started\.\n\nprice: \$0\.00\nprepared: label check of take gen_1 against 9 characters of required text\nprepared job: prep_l1\n\nThis needs a person's approval: nothing was started or spent/);
        expect(paths).toEqual(["/api/label-check", "/api/prepared-jobs"]);
        expect(calls[1]).toMatchObject({ engine: "label_check", args: { takeId: "gen_1", expected: "ACME COLA" } });
        expect(JSON.stringify(calls[1])).not.toMatch(/maxCredits|quoteOnly/i);
      }
      await spend("auto");
      for (const c of [1, line]) {
        credits = c; calls.length = 0;
        const text = await runDirectEngineTool("label_check", { take_id: "gen_1", expected: "ACME COLA", frame_upload_id: "up_1", mode: "contains", case: "fold", whitespace: "collapse" }, call);
        expect(text, String(c)).toMatch(/^Label checked: mismatch \(flagged for a person\)\./);
        expect(text).toContain("difference: 2 character(s)");
        expect(calls.map((x) => [x.quoteOnly === true, x.maxCredits ?? null])).toEqual([[true, null], [false, c]]);
        expect(calls[1]).toMatchObject({ takeId: "gen_1", frameUploadId: "up_1", mode: "contains", rules: { case: "fold", whitespace: "collapse" } });
      }
      for (const c of [line + 1, 900]) {
        credits = c; calls.length = 0;
        expect(await runDirectEngineTool("label_check", { take_id: "gen_1", expected: "ACME COLA" }, call), String(c)).toMatch(/not started[\s\S]*needs a person's approval/);
        expect(calls.some((x) => x.maxCredits !== undefined)).toBe(false);
      }
      credits = 1;
      for (const mode of ["ask", "auto"]) {
        await spend(mode); calls.length = 0;
        for (const bad of [{ maxCredits: 1 }, { max_credits: 1 }]) await expect(runDirectEngineTool("label_check", { take_id: "gen_1", expected: "ACME", ...bad }, call)).rejects.toThrow(/only a person approves/);
        expect(calls).toEqual([]);
      }
    } finally { await spend(null); }
  });
});

test("the fixture end to end (ENGINE_MOCK): the default adapter reads a picture in process with the network forbidden; a correct, a wrong and a text-free picture", async () => {
  process.env.VISION_LABEL_CHECK_ENABLED = "1";
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    await asTenant(house(), async () => {
      const ok = await take("t_fx_ok", "image", "ACME COLA");
      const bad = await take("t_fx_bad", "image", "ACME COIA");
      const blank = await take("t_fx_blank", "image", null);
      expect((await admit({ takeId: ok, expected: "ACME COLA", ...approved })).body).toMatchObject({ verdict: "match" });
      expect((await admit({ takeId: bad, expected: "ACME COLA", ...approved })).body).toMatchObject({ verdict: "mismatch", flagged: true });
      expect((await admit({ takeId: blank, expected: "ACME COLA", ...approved })).body).toMatchObject({ verdict: "missing", flagged: true });
      const refused = await take("t_fx_refuse", "image", "[[mock-refuse]]");
      expect((await admit({ takeId: refused, expected: "ACME", ...approved })).status).toBe(400);
      expect(outbound).toBe(0);
    });
  } finally { globalThis.fetch = original; }
});

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: no AI model is in the verdict, the seams stay internal, the route is the one door, the reservation comes before the read, and the take is never changed beyond the result", () => {
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\badmitLabelCheck\b/)).toEqual(["lib/visionLabel.ts"]);
  expect(reachers(/@\/lib\/visionLabel["']/)).toEqual(["app/api/label-check/route.ts"]);
  const flow = readFileSync("lib/visionLabel.ts", "utf8");
  const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  /* No model anywhere near the verdict: nothing from the text, image or chat engines is imported, and the verdict is the diff's own. */
  for (const file of ["lib/visionLabel.ts", "lib/labelDiff.ts", "lib/vision.ts"]) {
    expect(code(file), file).not.toMatch(/from "\.\/(gemini|openai|anthropic|xai|ark|textRoute|paidText|atomik|models|providers|engines|falImage|grok)[^"]*"/);
    expect(code(file), file).not.toMatch(/\b(openai|anthropic|claude|grok|llm|prompt)\b/i);
    /* "gemini" is only the Google funding bucket the allowance and the per-job line are asked about (Google's key pays for Vision as for Veo), never a model. */
    const gemini = [...code(file).matchAll(/gemini/gi)].length;
    expect(gemini, file).toBe([...code(file).matchAll(/(?:allowanceCheck\(|key: )"gemini"/g)].length);
  }
  expect(flow).toContain('verdict: diff.verdict, flagged: diff.verdict !== "match"');
  expect(code("lib/labelDiff.ts")).not.toMatch(/\bimport\b/);
  const at = (needle: string) => flow.indexOf(needle);
  expect(flow).toContain("admitLabelCheck(input, got, options, {})");
  expect(at("await shotCapGate({")).toBeGreaterThan(0);
  expect(at("await shotCapGate({")).toBeLessThan(at("if (quoteOnly)"));
  expect(at("await shotCapGate({")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("Approve the price first")).toBeLessThan(at("await reserveGenerationSpend("));
  expect(at("await reserveGenerationSpend(")).toBeLessThan(at("await (seams.detect ?? detectText)("));
  expect(at("await (seams.detect ?? detectText)(")).toBeLessThan(at("labelDiff(expected"));
  expect(at("labelDiff(expected")).toBeLessThan(at("json_set(params,'$.labelCheck'"));
  expect(at("json_set(params,'$.labelCheck'")).toBeLessThan(at('status: "succeeded", engineCostUsd: usd'));
  /* The only write to the take is its result: it is never given a status, deleted or hidden. */
  expect(flow).not.toMatch(/UPDATE generations SET (?!params=json_set\(params,'\$\.labelCheck')/);
  expect(code("lib/visionLabel.ts")).not.toMatch(/DELETE FROM/);
  const updates = [...code("lib/visionLabel.ts").matchAll(/UPDATE\s+\w+\s+SET\s+([^"`]*)/g)].map((m) => m[1]);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatch(/^params=json_set\(params,'\$\.labelCheck'/);
  expect(flow).toContain("quotedCredits(usd, marginKey)");
  expect(flow).not.toMatch(/0\.\d{2,}/);
  const adapter = readFileSync("lib/vision.ts", "utf8");
  const names = new Set([...code("lib/vision.ts").matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]));
  expect([...names].sort()).toEqual(["GOOGLE_VISION_API_KEY"]);
  expect(adapter).toContain('export const VISION_SWITCH = "VISION_LABEL_CHECK_ENABLED";');
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  const call = code("lib/vision.ts").match(/\(deps\.fetch \?\? recoveryFetch\)\(VISION_ENDPOINT, \{[\s\S]{0,500}/)?.[0] ?? "";
  expect(call).toMatch(/redirect: "error"/);
  expect(call).toMatch(/"x-goog-api-key": key/);
  expect(code("lib/vision.ts")).not.toMatch(/\?key=|key=\$\{/);
  /* No new table: the result lives in the take's own row. */
  expect(flow).not.toMatch(/CREATE TABLE|ALTER TABLE/i);
});
