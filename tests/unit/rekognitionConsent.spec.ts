import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The consent face gate (lib/consentMatchCore.ts behind lib/consentMatch.ts), the Rekognition adapter (lib/rekognition.ts) and the engine gate
 * (lib/engineGate.ts). Mocked: ENGINE_MOCK=1 answers every comparison from a fixture and no request leaves this process (the adapter tests hand it a fake
 * fetch). Local temporary databases only. The reference-image source returns null today, so most tests hand the gate a stub reference through the
 * INTERNAL seams (`matchConsentFace`, `runConsentCheckWith`), which the public gate does not offer.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-rekognition-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.REKOGNITION_ENABLED; process.env.ENGINE_MOCK = "1"; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const png = (text: string) => Buffer.from(text);
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function consent(projectId: string, subjectKey: string, over: { face?: boolean; revoked?: boolean; untilAt?: number; uses?: string[] } = {}): Promise<string> {
  const { db } = await import("../../lib/db");
  const { consentsReady } = await import("../../lib/security/consent");
  await consentsReady();
  const id = uid("consent");
  await db().execute({
    sql: `INSERT INTO identity_consents (id, project_id, subject_key, subject_label, person_name, covers_face, covers_voice, uses_json, other_use, until_at, recording_id, attested, recorded_by, recorded_at, revoked_at)
          VALUES (?,?,?,?,?,?,0,?,'',?,?,1,'u_test',?,?)`,
    args: [id, projectId, subjectKey, "", "Sample Person", over.face === false ? 0 : 1, JSON.stringify(over.uses ?? ["production"]), over.untilAt ?? Date.now() + 86_400_000, "rec_1", Date.now(), over.revoked ? Date.now() : null],
  });
  return id;
}
async function platformCounts(): Promise<{ rows: number; cost: number }> {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const r = (await platformDb().execute("SELECT COUNT(*) AS n, COALESCE(SUM(engine_cost_usd),0) AS c FROM meter_events WHERE engine='rekognition'")).rows[0];
  return { rows: Number(r.n), cost: Number(r.c) };
}
const stub = (face: string | null) => async () => (face ? png(`mock-face:${face}`) : null);
const scope = (projectId: string, use: "production" | "ads" | "social" | "identity" = "production") => ({ projectId, use });

test("the engine gate: the engine's own switch AND (the house OR a listed workspace); the switch is the kill switch; fail closed", async () => {
  const { engineEnabled, enginesOnWorkspaces } = await import("../../lib/engineGate");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const customer = { id: "ws_gate_customer" };
  const setList = (value: unknown) => platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [typeof value === "string" ? value : JSON.stringify(value)],
  });
  const before = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  try {
    await setList({ openSignup: false, enginesOnWorkspaces: [] });
    /* Switch unset or anything but "1": off for everyone, the house included. */
    for (const v of [undefined, "", "0", "true", "yes", "on"]) {
      if (v === undefined) delete process.env.REKOGNITION_ENABLED; else process.env.REKOGNITION_ENABLED = v;
      expect(await engineEnabled("REKOGNITION_ENABLED", { id: "ws_legacy" }), String(v)).toBe(false);
    }
    process.env.REKOGNITION_ENABLED = "1";
    expect(await engineEnabled("REKOGNITION_ENABLED", { id: "ws_legacy" })).toBe(true);
    expect(await engineEnabled("REKOGNITION_ENABLED", customer)).toBe(false);
    expect(await engineEnabled("REKOGNITION_ENABLED", null)).toBe(false);
    expect(await engineEnabled("REKOGNITION_ENABLED", undefined)).toBe(false);
    /* Listed: on for that workspace and no other; and the list alone, with the switch off, is nothing. */
    await setList({ enginesOnWorkspaces: [customer.id, "bad id; drop", 7] });
    expect(await enginesOnWorkspaces()).toEqual([customer.id]);
    expect(await engineEnabled("REKOGNITION_ENABLED", customer)).toBe(true);
    expect(await engineEnabled("REKOGNITION_ENABLED", { id: "ws_gate_other" })).toBe(false);
    delete process.env.REKOGNITION_ENABLED;
    expect(await engineEnabled("REKOGNITION_ENABLED", customer)).toBe(false);
    /* An unreadable row is nobody. */
    process.env.REKOGNITION_ENABLED = "1";
    await setList("{not json");
    expect(await enginesOnWorkspaces()).toEqual([]);
    expect(await engineEnabled("REKOGNITION_ENABLED", customer)).toBe(false);
    expect(await engineEnabled("REKOGNITION_ENABLED", { id: "ws_legacy" })).toBe(true);
  } finally {
    if (typeof before === "string") await setList(before); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("the face check is the HOUSE's only: a customer workspace on the engine list still has no tool and is refused, and nothing is metered", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { consentTools, runConsentCheck, requireConsentMatch, ConsentMatchError, ENGINE_OFF } = await import("../../lib/consentMatch");
  const { matchConsentFace } = await import("../../lib/consentMatchCore");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const listed = tenant("ws_listed_customer");
  const before = (await platformDb().execute("SELECT value FROM platform_layer WHERE key='site'")).rows[0]?.value;
  const setList = (value: unknown) => platformDb().execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, 0, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify(value)] });
  try {
    await setList({ enginesOnWorkspaces: [listed.id] });
    process.env.REKOGNITION_ENABLED = "1";
    const { engineEnabled } = await import("../../lib/engineGate");
    /* The shared engine gate says yes for it... */
    expect(await engineEnabled("REKOGNITION_ENABLED", listed)).toBe(true);
    await runInTenant(listed, async () => {
      const counts = await platformCounts();
      /* ...and the face check still does not run there: no tool, a refusal at the gate, with the real source and with a stub that would pass. */
      expect(await consentTools()).toEqual([]);
      expect(await runConsentCheck({ castMemberId: "cast_a", uploadId: "up_1", projectId: "prod_a", use: "production" })).toMatchObject({ ok: false, code: "absent" });
      const projectId = uid("prod"), cast = uid("cast");
      await consent(projectId, cast);
      for (const refused of [
        await requireConsentMatch(cast, png("mock-face:a"), scope(projectId)).then(() => null, (e) => e),
        await matchConsentFace(cast, png("mock-face:a"), scope(projectId), { reference: stub("a") }).then(() => null, (e) => e),
      ]) {
        expect(refused).toBeInstanceOf(ConsentMatchError);
        expect(refused).toMatchObject({ code: "off", status: 403, message: ENGINE_OFF });
      }
      expect(await platformCounts()).toEqual(counts);
    });
  } finally {
    if (typeof before === "string") await platformDb().execute({ sql: "UPDATE platform_layer SET value=? WHERE key='site'", args: [before] }); else await platformDb().execute("DELETE FROM platform_layer WHERE key='site'");
  }
});

test("switch off: the tool is absent, the gate refuses before reading or calling anything, and nothing is metered", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { consentTools, runConsentCheck, requireConsentMatch, ConsentMatchError, ENGINE_OFF } = await import("../../lib/consentMatch");
  await runInTenant(house(), async () => {
    const before = await platformCounts();
    delete process.env.REKOGNITION_ENABLED;
    expect(await consentTools()).toEqual([]);
    expect(await runConsentCheck({ castMemberId: "cast_a", uploadId: "up_1", projectId: "prod_a", use: "production" })).toMatchObject({ ok: false, code: "absent" });
    const projectId = uid("prod"), cast = uid("cast");
    await consent(projectId, cast);
    const refused = await requireConsentMatch(cast, png("mock-face:a"), scope(projectId)).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(ConsentMatchError);
    expect(refused).toMatchObject({ code: "off", status: 403, message: ENGINE_OFF });
    expect(await platformCounts()).toEqual(before);
    /* On, the tool is there, with its price and who may call it. */
    process.env.REKOGNITION_ENABLED = "1";
    expect(await consentTools()).toEqual([expect.objectContaining({ id: "consent.check", kind: "app", provider: "rekognition", who: "anyone", price: expect.objectContaining({ credits: 0 }) })]);
  });
});

test("a match: the same face passes, the call's real cost is on its ledger line at no credits, only ids, the score and the time are kept, and the bytes are named", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { matchConsentFace } = await import("../../lib/consentMatchCore");
  const { REKOGNITION_CALL_USD, REKOGNITION_USD_PER_IMAGE, REKOGNITION_IMAGES_PER_CALL } = await import("../../lib/rekognition");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  expect(REKOGNITION_CALL_USD).toBe(REKOGNITION_USD_PER_IMAGE * REKOGNITION_IMAGES_PER_CALL);
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    const consentId = await consent(projectId, cast);
    const before = await platformCounts();
    const face = png("mock-face:alice");
    const got = await matchConsentFace(cast, face, scope(projectId), { reference: stub("alice") });
    expect(got).toMatchObject({ consentId, matched: true, similarity: 99.2, faceSha256: sha(face) });
    const after = await platformCounts();
    expect(after.rows).toBe(before.rows + 1);
    expect(after.cost - before.cost).toBeCloseTo(REKOGNITION_CALL_USD, 8);
    const meterRow = (await platformDb().execute("SELECT status,engine_cost_usd,billed_credits,paid_by_platform,workspace_id FROM meter_events WHERE engine='rekognition' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(meterRow).toMatchObject({ status: "succeeded", workspace_id: "ws_legacy" });
    expect(Number(meterRow.billed_credits ?? 0)).toBe(0);
    expect(Number(meterRow.paid_by_platform)).toBe(0);
    const lines = (await db().execute({ sql: "SELECT workspace_id,actor_id,target_type,target_id,details,created_at FROM security_audit WHERE action='consent.face_checked' AND target_id=?", args: [consentId] })).rows;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ workspace_id: "ws_legacy", target_type: "identity_consent" });
    expect(JSON.parse(String(lines[0].details))).toEqual({ similarity: 99.2, matched: true });
    expect(Number(lines[0].created_at)).toBeGreaterThan(0);
  });
});

test("the scope is required: no production or no use is refused (bad-input), at the gate and at the tool, before anything is read or called", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { requireConsentMatch, runConsentCheck, ConsentMatchError } = await import("../../lib/consentMatch");
  const { matchConsentFace } = await import("../../lib/consentMatchCore");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await consent(projectId, cast);
    const before = await platformCounts();
    for (const bad of [{}, { use: "production" }, { projectId }, { projectId: "", use: "production" }, { projectId, use: "everything" }, { projectId: "bad id; drop", use: "ads" }, { projectId: 7, use: "ads" }]) {
      const label = JSON.stringify(bad);
      const gate = await requireConsentMatch(cast, png("mock-face:a"), bad as never).then(() => null, (e) => e);
      expect(gate, label).toBeInstanceOf(ConsentMatchError);
      expect(gate, label).toMatchObject({ code: "bad-input", status: 400 });
      expect(await matchConsentFace(cast, png("mock-face:a"), bad, { reference: stub("a") }).then(() => null, (e) => e), label).toMatchObject({ code: "bad-input" });
      expect(await runConsentCheck({ castMemberId: cast, uploadId: "up_x", ...bad }), label).toMatchObject({ ok: false, code: "bad-input" });
    }
    expect(await platformCounts()).toEqual(before);
  });
});

test("no match: a different face is refused for a person to look at; the call happened, so it is on the ledger, and the score is kept", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { matchConsentFace, ConsentMatchError, NO_MATCH } = await import("../../lib/consentMatchCore");
  const { db } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    const consentId = await consent(projectId, cast);
    const before = await platformCounts();
    const refused = await matchConsentFace(cast, png("mock-face:bob"), scope(projectId), { reference: stub("alice") }).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(ConsentMatchError);
    expect(refused).toMatchObject({ code: "no-match", status: 409, message: NO_MATCH });
    expect((await platformCounts()).rows).toBe(before.rows + 1);
    const line = (await db().execute({ sql: "SELECT details FROM security_audit WHERE action='consent.face_checked' AND target_id=?", args: [consentId] })).rows[0];
    expect(JSON.parse(String(line.details))).toEqual({ similarity: 11.4, matched: false });
  });
});

test("several faces: refused unless exactly one face; the call was analysed, so it is charged at its real cost", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { matchConsentFace, SEVERAL_FACES } = await import("../../lib/consentMatchCore");
  const { REKOGNITION_CALL_USD } = await import("../../lib/rekognition");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await consent(projectId, cast);
    const before = await platformCounts();
    const refused = await matchConsentFace(cast, png("mock-several faces"), scope(projectId), { reference: stub("alice") }).then(() => null, (e) => e);
    expect(refused).toMatchObject({ code: "several-faces", status: 422, message: SEVERAL_FACES });
    expect(SEVERAL_FACES).toBe("More than one face is in this image. Crop to the one face.");
    const after = await platformCounts();
    expect(after.rows).toBe(before.rows + 1);
    expect(after.cost - before.cost).toBeCloseTo(REKOGNITION_CALL_USD, 8);
  });
});

test("the threshold is judged on the raw score: 89.96 is refused though it rounds to 90; 90 passes; the history line rounds", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { matchConsentFace, ConsentMatchError } = await import("../../lib/consentMatchCore");
  const { db } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  delete process.env.ENGINE_MOCK;
  const env = { REKOGNITION_ACCESS_KEY_ID: "AKIATESTKEY0000TEST", REKOGNITION_SECRET_ACCESS_KEY: "test-secret-key-not-real" };
  const fetchWith = (similarity: number) => (async () => new Response(JSON.stringify({ FaceMatches: [{ Similarity: similarity }], UnmatchedFaces: [] }), { status: 200 })) as never;
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    const consentId = await consent(projectId, cast);
    const reference = async () => png("ref-bytes");
    const low = await matchConsentFace(cast, png("face-bytes"), scope(projectId), { reference, rekognition: { env, fetch: fetchWith(89.96) } }).then(() => null, (e) => e);
    expect(low).toBeInstanceOf(ConsentMatchError);
    expect(low).toMatchObject({ code: "no-match" });
    const face = png("face-bytes-2");
    const ok = await matchConsentFace(cast, face, scope(projectId), { reference, rekognition: { env, fetch: fetchWith(90) } });
    expect(ok).toMatchObject({ matched: true, similarity: 90, faceSha256: sha(face) });
    const lines = (await db().execute({ sql: "SELECT details FROM security_audit WHERE action='consent.face_checked' AND target_id=? ORDER BY created_at, id", args: [consentId] })).rows.map((r) => JSON.parse(String(r.details)));
    expect(lines).toEqual([{ similarity: 90, matched: false }, { similarity: 90, matched: true }]);
  });
});

test("a 200 with no face is charged: AWS analysed the images, so the row settles at the call's cost, and the person is not told 'Nothing billed'", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { matchConsentFace } = await import("../../lib/consentMatchCore");
  const { REKOGNITION_CALL_USD } = await import("../../lib/rekognition");
  process.env.REKOGNITION_ENABLED = "1";
  delete process.env.ENGINE_MOCK;
  const env = { REKOGNITION_ACCESS_KEY_ID: "AKIATESTKEY0000TEST", REKOGNITION_SECRET_ACCESS_KEY: "test-secret-key-not-real" };
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await consent(projectId, cast);
    const before = await platformCounts();
    const refused = await matchConsentFace(cast, png("face-bytes"), scope(projectId), {
      reference: async () => png("ref-bytes"), rekognition: { env, fetch: (async () => new Response(JSON.stringify({ FaceMatches: [], UnmatchedFaces: [] }), { status: 200 })) as never },
    }).then(() => null, (e) => e);
    expect(refused).toMatchObject({ code: "no-face", status: 422 });
    expect(String((refused as Error).message)).not.toMatch(/Nothing was billed/);
    const after = await platformCounts();
    expect(after.rows).toBe(before.rows + 1);
    expect(after.cost - before.cost).toBeCloseTo(REKOGNITION_CALL_USD, 8);
  });
});

test("no reference: today's consent has no face image, so every check is refused, nothing is called, nothing is billed", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { requireConsentMatch, ConsentMatchError, NO_REFERENCE } = await import("../../lib/consentMatch");
  const { matchConsentFace } = await import("../../lib/consentMatchCore");
  const { consentReferenceImage } = await import("../../lib/consentReference");
  process.env.REKOGNITION_ENABLED = "1";
  expect(await consentReferenceImage("any_consent")).toBeNull();
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await consent(projectId, cast);
    const before = await platformCounts();
    /* The public gate with the default source: the unchanged function returns null. */
    const refused = await requireConsentMatch(cast, png("mock-face:alice"), scope(projectId)).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(ConsentMatchError);
    expect(refused).toMatchObject({ code: "no-reference", status: 409, message: NO_REFERENCE });
    expect(NO_REFERENCE).toBe("This person's consent has no face reference yet.");
    expect(await platformCounts()).toEqual(before);
    /* An empty image from a source that answers is no reference either. */
    const empty = await matchConsentFace(cast, png("mock-face:alice"), scope(projectId), { reference: async () => Buffer.alloc(0) }).then(() => null, (e) => e);
    expect(empty).toMatchObject({ code: "no-reference" });
    expect(await platformCounts()).toEqual(before);
  });
});

test("provider error: refused, 'Nothing billed', the row settles at nothing and no score line is written; no face in an image is the same", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { matchConsentFace, ConsentMatchError, NOT_DONE } = await import("../../lib/consentMatchCore");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    const consentId = await consent(projectId, cast);
    const before = await platformCounts();
    const seams = { reference: stub("alice") };
    const down = await matchConsentFace(cast, png("mock-error"), scope(projectId), seams).then(() => null, (e) => e);
    expect(down).toBeInstanceOf(ConsentMatchError);
    expect(down).toMatchObject({ code: "unavailable", status: 503, message: NOT_DONE });
    expect(NOT_DONE).toMatch(/Nothing was billed/);
    const noFace = await matchConsentFace(cast, png("mock-noface"), scope(projectId), seams).then(() => null, (e) => e);
    expect(noFace).toMatchObject({ code: "no-face", status: 422 });
    expect(String((noFace as Error).message)).toMatch(/Nothing was billed/);
    const after = await platformCounts();
    expect(after.rows).toBe(before.rows + 2);
    expect(after.cost).toBeCloseTo(before.cost, 10);
    const failed = (await platformDb().execute("SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE engine='rekognition' ORDER BY created_at DESC LIMIT 2")).rows;
    for (const row of failed) {
      expect(row.status).toBe("failed");
      expect(Number(row.engine_cost_usd)).toBe(0);
      expect(Number(row.billed_credits ?? 0)).toBe(0);
    }
    expect((await db().execute({ sql: "SELECT COUNT(*) AS n FROM security_audit WHERE action='consent.face_checked' AND target_id=?", args: [consentId] })).rows[0].n).toBe(0);
    /* Not a face at all (an image the mock cannot read): refused the same way. */
    expect(await matchConsentFace(cast, png("not an image of anyone"), scope(projectId), seams).then(() => null, (e) => e)).toMatchObject({ code: "no-face" });
  });
});

test("consent that does not hold: none, a voice-only record, a withdrawn one, an ended one, another use, another production, an unknown cast member", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { matchConsentFace, NO_LIVE_CONSENT } = await import("../../lib/consentMatchCore");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const before = await platformCounts();
    const projectId = uid("prod");
    const ask = (cast: string, over: { projectId?: string; use?: "production" | "ads" } = {}) =>
      matchConsentFace(cast, png("mock-face:alice"), scope(over.projectId ?? projectId, over.use ?? "production"), { reference: stub("alice") }).then(() => null, (e) => e);
    const voice = uid("cast"), withdrawn = uid("cast"), ended = uid("cast"), ads = uid("cast"), live = uid("cast");
    await consent(projectId, voice, { face: false });
    await consent(projectId, withdrawn, { revoked: true });
    await consent(projectId, ended, { untilAt: Date.now() - 1000 });
    await consent(projectId, ads, { uses: ["ads"] });
    await consent(projectId, live);
    for (const cast of [uid("cast"), voice, withdrawn, ended]) expect(await ask(cast), cast).toMatchObject({ code: "no-consent", status: 409, message: NO_LIVE_CONSENT });
    expect(await ask(ads, { use: "production" })).toMatchObject({ code: "no-consent" });
    expect(await ask(live, { projectId: uid("other-prod") })).toMatchObject({ code: "no-consent" });
    /* The same records, asked for what they cover, hold. */
    expect(await ask(ads, { use: "ads" })).toBeNull();
    expect(await ask(live, { use: "production" })).toBeNull();
    /* Only the two that passed reached the provider. */
    expect((await platformCounts()).rows).toBe(before.rows + 2);
  });
});

test("the tool: an agent can run consent.check on an image from this workspace; another workspace's upload is simply not there; bad input is refused", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { runConsentCheckWith } = await import("../../lib/consentMatch");
  const { storeUpload } = await import("../../lib/storage");
  const { db, ready } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  const made: string[] = [];
  try {
    await runInTenant(house(), async () => {
      await ready();
      const projectId = uid("prod"), cast = uid("cast");
      await consent(projectId, cast);
      const put = async (id: string, text: string, mime = "image/png") => {
        await storeUpload(id, "png", png(text), mime);
        made.push(path.join(process.cwd(), ".data", "uploads", `${id}.png`));
        await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES(?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, mime, "png", text.length, "x", `uploads/${id}.png`, Date.now()] });
        return id;
      };
      const same = await put(uid("upl"), "mock-face:alice"), other = await put(uid("upl"), "mock-face:bob"), notImage = await put(uid("upl"), "mock-face:alice", "video/mp4");
      const seams = { reference: stub("alice") };
      const base = { castMemberId: cast, projectId, use: "production" };
      /* "An agent": it holds no session and no say over the switch, the source or the actor; the tool runs, and reads and compares only. */
      expect(await runConsentCheckWith({ ...base, uploadId: same }, seams)).toMatchObject({ ok: true, matched: true, similarity: 99.2, faceSha256: sha(png("mock-face:alice")) });
      expect(await runConsentCheckWith({ ...base, uploadId: other }, seams)).toMatchObject({ ok: false, code: "no-match" });
      expect(await runConsentCheckWith({ ...base, uploadId: notImage }, seams)).toMatchObject({ ok: false, code: "bad-input" });
      expect(await runConsentCheckWith({ ...base, uploadId: "up_in_another_workspace" }, seams)).toMatchObject({ ok: false, code: "bad-input" });
      expect(await runConsentCheckWith({ ...base, uploadId: "../etc/passwd" }, seams)).toMatchObject({ ok: false, code: "bad-input" });
      expect(await runConsentCheckWith({ ...base, castMemberId: "", uploadId: same }, seams)).toMatchObject({ ok: false, code: "bad-input" });
    });
  } finally {
    for (const file of made) await unlink(file).catch(() => {});
  }
});

test("the tool reads only an upload the person may open: another person's private upload is refused before any reference is read or any call is made, and nothing is billed", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { runConsentCheckWith } = await import("../../lib/consentMatch");
  const { storeUpload } = await import("../../lib/storage");
  const { db, ready } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  const made: string[] = [];
  const member = (id: string) => ({ id, email: `${id}@example.invalid`, name: id, role: "member", owner: false, disabled: false, createdAt: 0, lastSeen: null });
  try {
    const projectId = uid("prod"), cast = uid("cast");
    const upl = uid("upl_private"), mine = uid("upl_mine");
    await runInTenant(house(), async () => {
      await ready();
      await consent(projectId, cast);
      for (const [id, uploader] of [[upl, "person_other"], [mine, "person_me"]] as const) {
        await storeUpload(id, "png", png("mock-face:alice"), "image/png");
        made.push(path.join(process.cwd(), ".data", "uploads", `${id}.png`));
        await db().execute({ sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,uploader_id) VALUES(?,?,?,?,?,?,?,?,?)", args: [id, `${id}.png`, "image/png", "png", 15, "x", `uploads/${id}.png`, Date.now(), uploader] });
      }
    }, { user: member("person_me") } as never);
    let referenceReads = 0;
    const seams = { reference: async () => { referenceReads++; return png("mock-face:alice"); } };
    const base = { castMemberId: cast, projectId, use: "production" };
    await runInTenant(house(), async () => {
      const counts = await platformCounts();
      /* Not theirs and not shared: answered exactly as an upload that is not there, before the reference is read or the provider called. */
      expect(await runConsentCheckWith({ ...base, uploadId: upl }, seams)).toMatchObject({ ok: false, code: "bad-input", message: "Pick an image from this workspace's uploads." });
      expect(await runConsentCheckWith({ ...base, uploadId: "up_not_there" }, seams)).toMatchObject({ ok: false, code: "bad-input", message: "Pick an image from this workspace's uploads." });
      expect(referenceReads).toBe(0);
      expect(await platformCounts()).toEqual(counts);
      /* Their own upload is theirs to check. */
      expect(await runConsentCheckWith({ ...base, uploadId: mine }, seams)).toMatchObject({ ok: true, matched: true });
      expect(referenceReads).toBe(1);
    }, { user: member("person_me") } as never);
  } finally {
    for (const file of made) await unlink(file).catch(() => {});
  }
});

test("the adapter: a real request is a SigV4-signed CompareFaces call to Mumbai; no face and a refusal cost nothing, a 200 with no face is charged; no key says which; only ap-south-1", async () => {
  const { compareFacesWith, RekognitionError } = await import("../../lib/rekognition");
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const reply = (status: number, json: unknown) => async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
  };
  const env = { REKOGNITION_ACCESS_KEY_ID: "AKIATESTKEY0000TEST", REKOGNITION_SECRET_ACCESS_KEY: "test-secret-key-not-real", REKOGNITION_REGION: "ap-south-1" };
  const now = () => new Date("2026-10-15T10:00:00Z");
  delete process.env.ENGINE_MOCK;
  const a = Buffer.from("source-bytes"), b = Buffer.from("target-bytes");
  const got = await compareFacesWith(a, b, { env, now, fetch: reply(200, { FaceMatches: [{ Similarity: 87.5 }, { Similarity: 96.25 }], UnmatchedFaces: [{}] }) as never });
  expect(got).toEqual({ similarity: 96.25, facesFound: 3 });
  const call = calls[0];
  expect(call.url).toBe("https://rekognition.ap-south-1.amazonaws.com/");
  expect(call.headers["x-amz-target"]).toBe("RekognitionService.CompareFaces");
  expect(call.headers["content-type"]).toBe("application/x-amz-json-1.1");
  expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTKEY0000TEST\/20261015\/ap-south-1\/rekognition\/aws4_request, SignedHeaders=.*content-type.*host.*x-amz-date.*x-amz-target, Signature=[a-f0-9]{64}$/);
  expect(call.headers["x-amz-date"]).toBe("20261015T100000Z");
  expect(JSON.parse(call.body)).toEqual({ SourceImage: { Bytes: a.toString("base64") }, TargetImage: { Bytes: b.toString("base64") }, SimilarityThreshold: 0 });
  expect(JSON.stringify(call)).not.toContain(env.REKOGNITION_SECRET_ACCESS_KEY);
  /* Answered before analysis: no face (not billed), by kind. */
  const noFace = await compareFacesWith(a, b, { env, now, fetch: reply(400, { __type: "InvalidParameterException", Message: "There are no faces in the image. Should be at least 1." }) as never }).then(() => null, (e) => e);
  expect(noFace).toBeInstanceOf(RekognitionError);
  expect(noFace).toMatchObject({ kind: "no-face", status: 400, billed: false });
  /* A 200 with no face: AWS analysed the images, so it is charged. */
  expect(await compareFacesWith(a, b, { env, now, fetch: reply(200, { FaceMatches: [], UnmatchedFaces: [] }) as never }).then(() => null, (e) => e)).toMatchObject({ kind: "no-face", billed: true });
  /* Anything else is a provider failure: no score, nothing assumed. */
  for (const status of [403, 429, 500, 503]) expect(await compareFacesWith(a, b, { env, now, fetch: reply(status, { __type: "ThrottlingException", Message: "slow down" }) as never }).then(() => null, (e) => e), String(status)).toMatchObject({ kind: "provider", status, billed: false });
  expect(await compareFacesWith(a, b, { env, now, fetch: (async () => { throw new Error("socket hang up"); }) as never }).then(() => null, (e) => e)).toMatchObject({ kind: "provider" });
  /* No key: it says which settings, and calls nothing. */
  const sent = calls.length;
  const none = await compareFacesWith(a, b, { env: {}, now, fetch: reply(200, {}) as never }).then(() => null, (e) => e);
  expect(none).toMatchObject({ kind: "provider" });
  expect(String((none as Error).message)).toContain("REKOGNITION_ACCESS_KEY_ID");
  expect(calls.length).toBe(sent);
  /* Faces go to Mumbai only: any other region, a lookalike, or a hostname is refused before anything is signed; unset is Mumbai. */
  for (const region of ["us-east-1", "eu-west-1", "ap-south-2", "evil.example.com/x", "AP-SOUTH-1"]) {
    expect(await compareFacesWith(a, b, { env: { ...env, REKOGNITION_REGION: region }, now, fetch: reply(200, {}) as never }).then(() => null, (e) => e), region).toMatchObject({ kind: "provider" });
  }
  expect(calls.length).toBe(sent);
  for (const region of ["", undefined]) {
    await compareFacesWith(a, b, { env: { ...env, REKOGNITION_REGION: region }, now, fetch: reply(200, { FaceMatches: [{ Similarity: 91 }] }) as never });
    expect(calls.at(-1)!.url).toBe("https://rekognition.ap-south-1.amazonaws.com/");
  }
  /* Over 5 MB or empty: refused before any request. */
  const total = calls.length;
  for (const bad of [Buffer.alloc(0), Buffer.alloc(5 * 1024 * 1024 + 1)]) expect(await compareFacesWith(bad, b, { env, now, fetch: reply(200, {}) as never }).then(() => null, (e) => e)).toMatchObject({ kind: "bad-image" });
  expect(calls.length).toBe(total);
});

/** Every source file under lib, app and components. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) out.push(p.split(path.sep).join("/")); } };
  for (const d of ["lib", "app", "components"]) walk(d);
  return out;
}

test("structure: no bypass seam on the public door, nothing but the core reaches the test seams, no AWS SDK, the secret is read by name only", () => {
  const adapter = readFileSync("lib/rekognition.ts", "utf8");
  expect(adapter).not.toMatch(/@aws-sdk|from ["']aws-/);
  expect(adapter).toContain("signRequest");
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  /* The exported compareFaces and the public gate take no switch, source, environment, fetch or actor. */
  expect(adapter).toContain("export const compareFaces = (source: Buffer, target: Buffer): Promise<FaceComparison> =>");
  const door = readFileSync("lib/consentMatch.ts", "utf8");
  expect(door).toContain("export const requireConsentMatch = (castMemberId: string, faceImage: Buffer, scope: ConsentScope): Promise<ConsentMatch> =>");
  expect(door).toContain("export const runConsentCheck = (input: ConsentCheckInput): Promise<ConsentCheckResult> =>");
  expect(door).not.toMatch(/\bdeps\b/);
  /* The seams (`compareFacesWith`, `matchConsentFace`, `runConsentCheckWith`) are reached only by the core, the door, and tests. */
  const reachers = (needle: RegExp) => sourceFiles().filter((f) => needle.test(readFileSync(f, "utf8"))).sort();
  expect(reachers(/\bcompareFacesWith\b/)).toEqual(["lib/consentMatchCore.ts", "lib/rekognition.ts"]);
  expect(reachers(/consentMatchCore["']/)).toEqual(["lib/consentMatch.ts"]);
  expect(reachers(/\brunConsentCheckWith\b/)).toEqual(["lib/consentMatch.ts"]);
  expect(reachers(/\bmatchConsentFace\b/)).toEqual(["lib/consentMatch.ts", "lib/consentMatchCore.ts"]);
  /* The gate's core: house only, the engine gate, exactly one face, the raw score, the rounded line. */
  const core = readFileSync("lib/consentMatchCore.ts", "utf8");
  expect(core).toContain("if (!isHouseWorkspace(workspace)) return false;");
  expect(core).toContain('if (result.facesFound !== 1) throw new ConsentMatchError("several-faces"');
  expect(core).toContain("const matched = result.similarity >= CONSENT_MATCH_THRESHOLD;");
  expect(core).toContain("details: { similarity: round1(result.similarity), matched }");
  expect(core).not.toMatch(/storeUpload|storeImageBytes|writeFile/);
  /* The reference source is one function in one file, and it is null until the owner chooses. */
  expect(readFileSync("lib/consentReference.ts", "utf8")).toContain("return null;");
  /* The platform's spend rule has no special case for this engine: a listed workspace could not escape its allowance through one. */
  expect(readFileSync("lib/platformSpend.ts", "utf8")).not.toMatch(/rekognition/i);
  /* The only environment names: the provider's own, read by name in the adapter, and the kill switch the gate reads. */
  const reads = new Set([...adapter.matchAll(/env\.(REKOGNITION_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...reads].sort()).toEqual(["REKOGNITION_ACCESS_KEY_ID", "REKOGNITION_REGION", "REKOGNITION_SECRET_ACCESS_KEY"]);
  expect(adapter).toContain('export const REKOGNITION_SWITCH = "REKOGNITION_ENABLED";');
});
