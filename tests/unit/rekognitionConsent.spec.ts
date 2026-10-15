import { test, expect } from "@playwright/test";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The consent face gate (lib/consentMatch.ts), the Rekognition adapter (lib/rekognition.ts) and the engine gate (lib/engineGate.ts).
 * Mocked: ENGINE_MOCK=1 answers every comparison from a fixture and no request leaves this process (the one SigV4 test hands the adapter a fake
 * fetch). Local temporary databases only. The reference-image source returns null today, so most tests hand the gate a stub reference.
 *
 * Unit files share one platform database per worker and the house's id with it, so figures are read before and after, never absolute.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-rekognition-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
test.beforeAll(async () => { await alignLedgerUnit(); });
test.afterEach(() => { delete process.env.REKOGNITION_ENABLED; });

const tenant = (id: string, over: Partial<TenantWorkspace> = {}): TenantWorkspace => ({
  id, slug: id, name: id, legacy: id === "ws_legacy", dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true,
  allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null,
  concurrency: 50, rendersPerHour: 1000, storageQuotaBytes: null, deletedAt: null, ...over,
} as TenantWorkspace);
const house = () => tenant("ws_legacy");
const png = (text: string) => Buffer.from(text);
let n = 0;
const uid = (label: string) => `${label}_${Date.now().toString(36)}_${++n}`;

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

test("switch off: the tool is absent, the gate refuses before reading or calling anything, and nothing is metered", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { consentTools, runConsentCheck, requireConsentMatch, ConsentMatchError, ENGINE_OFF } = await import("../../lib/consentMatch");
  await runInTenant(house(), async () => {
    const before = await platformCounts();
    delete process.env.REKOGNITION_ENABLED;
    expect(await consentTools()).toEqual([]);
    expect(await runConsentCheck({ castMemberId: "cast_a", uploadId: "up_1" })).toMatchObject({ ok: false, code: "absent" });
    const projectId = uid("prod"), cast = uid("cast");
    await consent(projectId, cast);
    const refused = await requireConsentMatch(cast, png("mock-face:a"), { projectId, deps: { reference: stub("a") } }).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(ConsentMatchError);
    expect(refused).toMatchObject({ code: "off", status: 403, message: ENGINE_OFF });
    expect(await platformCounts()).toEqual(before);
    /* On, the tool is there, with its price and who may call it. */
    process.env.REKOGNITION_ENABLED = "1";
    expect(await consentTools()).toEqual([expect.objectContaining({ id: "consent.check", kind: "app", provider: "rekognition", who: "anyone", price: expect.objectContaining({ credits: 0 }) })]);
  });
});

test("a match: the same face passes, the call's real cost is on its ledger line at no credits, and only ids, the score and the time are kept", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { requireConsentMatch } = await import("../../lib/consentMatch");
  const { REKOGNITION_USD_PER_IMAGE } = await import("../../lib/rekognition");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    const consentId = await consent(projectId, cast);
    const before = await platformCounts();
    const got = await requireConsentMatch(cast, png("mock-face:alice"), { projectId, use: "production", by: "user_1", deps: { reference: stub("alice") } });
    expect(got).toMatchObject({ consentId, matched: true, similarity: 99.2 });
    const after = await platformCounts();
    expect(after.rows).toBe(before.rows + 1);
    expect(after.cost - before.cost).toBeCloseTo(REKOGNITION_USD_PER_IMAGE, 8);
    const meterRow = (await platformDb().execute("SELECT status,engine_cost_usd,billed_credits,paid_by_platform,workspace_id FROM meter_events WHERE engine='rekognition' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(meterRow).toMatchObject({ status: "succeeded", workspace_id: "ws_legacy" });
    expect(Number(meterRow.billed_credits ?? 0)).toBe(0);
    expect(Number(meterRow.paid_by_platform)).toBe(0);
    const lines = (await db().execute({ sql: "SELECT workspace_id,actor_id,target_type,target_id,details,created_at FROM security_audit WHERE action='consent.face_checked' AND target_id=?", args: [consentId] })).rows;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ workspace_id: "ws_legacy", actor_id: "user_1", target_type: "identity_consent" });
    expect(JSON.parse(String(lines[0].details))).toEqual({ similarity: 99.2, matched: true });
    expect(Number(lines[0].created_at)).toBeGreaterThan(0);
  });
});

test("no match: a different face is refused for a person to look at; the call happened, so it is on the ledger, and the score is kept", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { requireConsentMatch, ConsentMatchError, NO_MATCH } = await import("../../lib/consentMatch");
  const { db } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    const consentId = await consent(projectId, cast);
    const before = await platformCounts();
    const refused = await requireConsentMatch(cast, png("mock-face:bob"), { projectId, deps: { reference: stub("alice") } }).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(ConsentMatchError);
    expect(refused).toMatchObject({ code: "no-match", status: 409, message: NO_MATCH });
    expect((await platformCounts()).rows).toBe(before.rows + 1);
    const line = (await db().execute({ sql: "SELECT details FROM security_audit WHERE action='consent.face_checked' AND target_id=?", args: [consentId] })).rows[0];
    expect(JSON.parse(String(line.details))).toEqual({ similarity: 11.4, matched: false });
  });
});

test("no reference: today's consent has no face image, so every check is refused, nothing is called, nothing is billed", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { requireConsentMatch, ConsentMatchError, NO_REFERENCE } = await import("../../lib/consentMatch");
  const { consentReferenceImage } = await import("../../lib/consentReference");
  process.env.REKOGNITION_ENABLED = "1";
  expect(await consentReferenceImage("any_consent")).toBeNull();
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    await consent(projectId, cast);
    const before = await platformCounts();
    /* The default source, not a stub: the unchanged function returns null. */
    const refused = await requireConsentMatch(cast, png("mock-face:alice"), { projectId }).then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(ConsentMatchError);
    expect(refused).toMatchObject({ code: "no-reference", status: 409, message: NO_REFERENCE });
    expect(NO_REFERENCE).toBe("This person's consent has no face reference yet.");
    expect(await platformCounts()).toEqual(before);
    /* An empty image from a source that answers is no reference either. */
    const empty = await requireConsentMatch(cast, png("mock-face:alice"), { projectId, deps: { reference: async () => Buffer.alloc(0) } }).then(() => null, (e) => e);
    expect(empty).toMatchObject({ code: "no-reference" });
    expect(await platformCounts()).toEqual(before);
  });
});

test("provider error: refused, 'Nothing billed', the row settles at nothing and no score line is written; no face in an image is the same", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { requireConsentMatch, ConsentMatchError, NOT_DONE } = await import("../../lib/consentMatch");
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const projectId = uid("prod"), cast = uid("cast");
    const consentId = await consent(projectId, cast);
    const before = await platformCounts();
    const down = await requireConsentMatch(cast, png("mock-error"), { projectId, deps: { reference: stub("alice") } }).then(() => null, (e) => e);
    expect(down).toBeInstanceOf(ConsentMatchError);
    expect(down).toMatchObject({ code: "unavailable", status: 503, message: NOT_DONE });
    expect(NOT_DONE).toMatch(/Nothing was billed/);
    const noFace = await requireConsentMatch(cast, png("mock-noface"), { projectId, deps: { reference: stub("alice") } }).then(() => null, (e) => e);
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
    expect(await requireConsentMatch(cast, png("not an image of anyone"), { projectId, deps: { reference: stub("alice") } }).then(() => null, (e) => e)).toMatchObject({ code: "no-face" });
  });
});

test("consent that does not hold: none, a voice-only record, a withdrawn one, an ended one, another use, another production, an unknown cast member", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { requireConsentMatch, NO_LIVE_CONSENT } = await import("../../lib/consentMatch");
  process.env.REKOGNITION_ENABLED = "1";
  await runInTenant(house(), async () => {
    const before = await platformCounts();
    const projectId = uid("prod");
    const ask = (cast: string, over: { projectId?: string; use?: "production" | "ads" } = {}) =>
      requireConsentMatch(cast, png("mock-face:alice"), { projectId: over.projectId ?? projectId, use: over.use, deps: { reference: stub("alice") } }).then(() => null, (e) => e);
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
  const { runConsentCheck } = await import("../../lib/consentMatch");
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
      const deps = { reference: stub("alice") };
      /* "An agent": its id is an agent's, it holds no session, and the tool runs: reads and compares, nothing it may not do. */
      const agent = { by: "agent:run_test", projectId, deps };
      expect(await runConsentCheck({ castMemberId: cast, uploadId: same, use: "production" }, agent)).toMatchObject({ ok: true, matched: true, similarity: 99.2 });
      expect(await runConsentCheck({ castMemberId: cast, uploadId: other }, agent)).toMatchObject({ ok: false, code: "no-match" });
      expect(await runConsentCheck({ castMemberId: cast, uploadId: notImage }, agent)).toMatchObject({ ok: false, code: "bad-input" });
      expect(await runConsentCheck({ castMemberId: cast, uploadId: "up_in_another_workspace" }, agent)).toMatchObject({ ok: false, code: "bad-input" });
      expect(await runConsentCheck({ castMemberId: cast, uploadId: "../etc/passwd" }, agent)).toMatchObject({ ok: false, code: "bad-input" });
      expect(await runConsentCheck({ castMemberId: "", uploadId: same }, agent)).toMatchObject({ ok: false, code: "bad-input" });
    });
  } finally {
    for (const file of made) await unlink(file).catch(() => {});
  }
});

test("the adapter: a real request is a SigV4-signed CompareFaces call to Mumbai with the key pair's own names; no face and a refusal cost nothing; no key says which", async () => {
  const { compareFaces, RekognitionError } = await import("../../lib/rekognition");
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const reply = (status: number, json: unknown) => async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
  };
  const env = { REKOGNITION_ACCESS_KEY_ID: "AKIATESTKEY0000TEST", REKOGNITION_SECRET_ACCESS_KEY: "test-secret-key-not-real", REKOGNITION_REGION: "ap-south-1" };
  const now = () => new Date("2026-10-15T10:00:00Z");
  const mockOff = process.env.ENGINE_MOCK;
  delete process.env.ENGINE_MOCK;
  try {
    const a = Buffer.from("source-bytes"), b = Buffer.from("target-bytes");
    const got = await compareFaces(a, b, { env, now, fetch: reply(200, { FaceMatches: [{ Similarity: 87.5 }, { Similarity: 96.25 }], UnmatchedFaces: [{}] }) as never });
    expect(got).toEqual({ similarity: 96.25, facesFound: 3 });
    const call = calls[0];
    expect(call.url).toBe("https://rekognition.ap-south-1.amazonaws.com/");
    expect(call.headers["x-amz-target"]).toBe("RekognitionService.CompareFaces");
    expect(call.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTKEY0000TEST\/20261015\/ap-south-1\/rekognition\/aws4_request, SignedHeaders=.*content-type.*host.*x-amz-date.*x-amz-target, Signature=[a-f0-9]{64}$/);
    expect(call.headers["x-amz-date"]).toBe("20261015T100000Z");
    expect(JSON.parse(call.body)).toEqual({ SourceImage: { Bytes: a.toString("base64") }, TargetImage: { Bytes: b.toString("base64") }, SimilarityThreshold: 0 });
    /* The secret never leaves the process in a header or the body. */
    expect(JSON.stringify(call)).not.toContain(env.REKOGNITION_SECRET_ACCESS_KEY);
    /* Answered before analysis: no face (not billed), by kind. */
    const noFace = await compareFaces(a, b, { env, now, fetch: reply(400, { __type: "InvalidParameterException", Message: "There are no faces in the image. Should be at least 1." }) as never }).then(() => null, (e) => e);
    expect(noFace).toBeInstanceOf(RekognitionError);
    expect(noFace).toMatchObject({ kind: "no-face", status: 400 });
    expect(await compareFaces(a, b, { env, now, fetch: reply(200, { FaceMatches: [], UnmatchedFaces: [] }) as never }).then(() => null, (e) => e)).toMatchObject({ kind: "no-face" });
    /* Anything else is a provider failure: no score, nothing assumed. */
    for (const status of [403, 429, 500, 503]) expect(await compareFaces(a, b, { env, now, fetch: reply(status, { __type: "ThrottlingException", Message: "slow down" }) as never }).then(() => null, (e) => e), String(status)).toMatchObject({ kind: "provider", status });
    expect(await compareFaces(a, b, { env, now, fetch: (async () => { throw new Error("socket hang up"); }) as never }).then(() => null, (e) => e)).toMatchObject({ kind: "provider" });
    /* No key: it says which settings, and calls nothing. */
    const sent = calls.length;
    const none = await compareFaces(a, b, { env: {}, now, fetch: reply(200, {}) as never }).then(() => null, (e) => e);
    expect(none).toMatchObject({ kind: "provider" });
    expect(String((none as Error).message)).toContain("REKOGNITION_ACCESS_KEY_ID");
    expect(calls.length).toBe(sent);
    /* A region that is not a region name is refused before anything is signed; the default is Mumbai. */
    expect(await compareFaces(a, b, { env: { ...env, REKOGNITION_REGION: "evil.example.com/x" }, now, fetch: reply(200, {}) as never }).then(() => null, (e) => e)).toMatchObject({ kind: "provider" });
    await compareFaces(a, b, { env: { ...env, REKOGNITION_REGION: "" }, now, fetch: reply(200, { FaceMatches: [{ Similarity: 91 }] }) as never });
    expect(calls.at(-1)!.url).toBe("https://rekognition.ap-south-1.amazonaws.com/");
    /* Over 5 MB or empty: refused before any request. */
    const total = calls.length;
    for (const bad of [Buffer.alloc(0), Buffer.alloc(5 * 1024 * 1024 + 1)]) expect(await compareFaces(bad, b, { env, now, fetch: reply(200, {}) as never }).then(() => null, (e) => e)).toMatchObject({ kind: "bad-image" });
    expect(calls.length).toBe(total);
  } finally {
    if (mockOff !== undefined) process.env.ENGINE_MOCK = mockOff;
  }
});

test("structure: no AWS SDK, the secret is read by name only, the gate and the tool are what other tools import, and the audit holds no image", () => {
  const adapter = readFileSync("lib/rekognition.ts", "utf8");
  expect(adapter).not.toMatch(/@aws-sdk|from ["']aws-/);
  expect(adapter).toContain("signRequest");
  expect(adapter).not.toMatch(/console\.(log|error|info)/);
  const gate = readFileSync("lib/consentMatch.ts", "utf8");
  expect(gate).toContain("export async function requireConsentMatch(castMemberId: string, faceImage: Buffer");
  /* No image, crop or vector is written anywhere: the only stored fields are the consent id, the score, the pass flag and the time. */
  expect(gate).toContain('details: { similarity: score, matched }');
  expect(gate).not.toMatch(/storeUpload|storeImageBytes|writeFile/);
  /* The reference source is one function in one file, and it is null until the owner chooses. */
  expect(readFileSync("lib/consentReference.ts", "utf8")).toContain("return null;");
  /* The only environment names: the provider's own, read by name in the adapter, and the kill switch the gate reads. */
  const reads = new Set([...adapter.matchAll(/env\.(REKOGNITION_[A-Z_]+)/g)].map((m) => m[1]));
  expect([...reads].sort()).toEqual(["REKOGNITION_ACCESS_KEY_ID", "REKOGNITION_REGION", "REKOGNITION_SECRET_ACCESS_KEY"]);
  expect(adapter).toContain('export const REKOGNITION_SWITCH = "REKOGNITION_ENABLED";');
});
