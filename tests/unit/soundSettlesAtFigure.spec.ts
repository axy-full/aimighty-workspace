import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-sound-figure-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

/* Rule 14: a finished sound is charged what it cost, never past the figure the person approved, as a dub settles
   at its reservation. The mocked vendor reports what it quoted, so each case here hands seal() its own report. */

const actor = { user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin" as const, owner: true, disabled: false, createdAt: 0, lastSeen: null } };

async function workspace(id: string, ownKey = false) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)",
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  await grantCredits(id, 100, "Test funds", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  return ownKey ? { ...ws, keys: { elevenlabs: "test-own-key" } } : ws;
}

/** What the vendor answered: `credits` it reports, or the dollars a per-minute task states. */
function report(credits: number, costUsd?: number) {
  return {
    kind: "audio" as const, storedUrl: "mock://sound.mp3", bytes: 1024, credits, requestId: null,
    ...(costUsd != null ? { costUsd } : {}), seconds: 2, timings: { queueMs: 0, engineMs: 1, storeMs: 1 },
  };
}

async function settled(workspaceId: string, id: string) {
  const { platformDb } = await import("../../lib/platform");
  const { db } = await import("../../lib/db");
  const { billingStateFor } = await import("../../lib/billingLedger");
  return {
    meter: (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits,overrun_usd FROM meter_events WHERE id=?", args: [id] })).rows[0],
    debit: Number((await platformDb().execute({ sql: "SELECT credits FROM billing_debits WHERE workspace_id=? AND event_id=?", args: [workspaceId, id] })).rows[0]?.credits ?? 0),
    balance: (await billingStateFor(workspaceId)).credits.balance,
    row: (await db().execute({ sql: "SELECT status,cost_usd FROM generations WHERE id=?", args: [id] })).rows[0],
  };
}

test("a sound the vendor charged more for is billed at the approved figure, and the rest is the platform's", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  const { executeAudioAdmission } = await import("../../lib/audioAdmission");
  const { loadJob, seal } = await import("../../lib/renderWork");
  const { usdForCredits } = await import("../../lib/elevenlabs");
  const ws = await workspace("sound-over");
  await runInTenant(ws, async () => {
    await ready();
    const line = { task: "sound", text: "Rain on a tin roof at night" };
    const quote = await executeAudioAdmission({ ...line, quoteOnly: true }, actor, { defer: async () => {} });
    expect(quote.status, JSON.stringify(quote.body)).toBe(200);
    const approved = Number(quote.body.estimatedCredits);
    expect(approved).toBeGreaterThan(0);
    const made = await executeAudioAdmission({ ...line, maxCredits: approved }, actor, { defer: async () => {} });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const id = String(made.body.id);
    const job = (await loadJob(id))!;
    expect(job.kind).toBe("audio");
    if (job.kind !== "audio") return;
    /* What was reserved is what the person approved. */
    expect((await settled(ws.id, id)).balance).toBe(100 - approved);
    const reserved = usdForCredits(job.estCredits, null);
    const vendorCredits = job.estCredits * 20;
    const reported = usdForCredits(vendorCredits, "creator");
    expect(reported).toBeGreaterThan(reserved);
    await seal(job, report(vendorCredits));
    const after = await settled(ws.id, id);
    expect(after.meter.status).toBe("succeeded");
    expect(Number(after.meter.engine_cost_usd)).toBeCloseTo(reserved, 10);
    expect(Number(after.meter.billed_credits)).toBe(approved);
    expect(after.debit).toBe(approved);
    expect(after.balance).toBe(100 - approved);
    expect(Number(after.meter.overrun_usd)).toBeCloseTo(reported - reserved, 10);
    expect(after.row.status).toBe("succeeded");
    expect(Number(after.row.cost_usd)).toBeCloseTo(reserved, 10);
  }, actor);
});

test("a per-minute sound that states more dollars than its quote is billed at the quote", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { loadJob, seal } = await import("../../lib/renderWork");
  const { grokSpeechUsd } = await import("../../lib/xaiVoice");
  const ws = await workspace("sound-stated-over");
  const id = "sound-stated-over";
  const text = "Not tonight.";
  const estUsd = grokSpeechUsd(text);
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES(?,'audio','grok-tts',?,?,'running',?,?)",
      args: [id, text, JSON.stringify({ task: "speech", voiceId: "eve", estUsd }), Date.now(), Date.now()],
    });
    await reserveGenerationSpend({ id, kind: "audio", engine: "xai", model: "grok-tts", status: "running", engineCostUsd: estUsd });
    const reservedCredits = 100 - (await settled(ws.id, id)).balance;
    expect(reservedCredits).toBeGreaterThan(0);
    await seal((await loadJob(id))!, report(0, estUsd * 3));
    const after = await settled(ws.id, id);
    expect(Number(after.meter.engine_cost_usd)).toBeCloseTo(estUsd, 10);
    expect(Number(after.meter.billed_credits)).toBe(reservedCredits);
    expect(after.debit).toBe(reservedCredits);
    expect(after.balance).toBe(100 - reservedCredits);
    expect(Number(after.meter.overrun_usd)).toBeCloseTo(estUsd * 2, 10);
    expect(Number(after.row.cost_usd)).toBeCloseTo(estUsd, 10);
  });
});

test("a sound that cost less than its quote is billed at what it cost, with nothing past it", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { loadJob, seal } = await import("../../lib/renderWork");
  const { creditsAtTerms, currentBillingTerms } = await import("../../lib/billingTerms");
  const { grokSpeechUsd } = await import("../../lib/xaiVoice");
  const ws = await workspace("sound-under");
  const id = "sound-under";
  const text = "Not tonight.";
  /* A quote of several credits, from the code's own figures, so that a quarter of it is still fewer. */
  const terms = currentBillingTerms("audio", "grok-tts");
  let estUsd = grokSpeechUsd(text);
  while (creditsAtTerms(estUsd, terms) < 12) estUsd *= 2;
  const reported = estUsd / 4;
  const expected = creditsAtTerms(reported, terms);
  await runInTenant(ws, async () => {
    await ready();
    await db().execute({
      sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES(?,'audio','grok-tts',?,?,'running',?,?)",
      args: [id, text, JSON.stringify({ task: "speech", voiceId: "eve", estUsd }), Date.now(), Date.now()],
    });
    await reserveGenerationSpend({ id, kind: "audio", engine: "xai", model: "grok-tts", status: "running", engineCostUsd: estUsd });
    const reservedCredits = 100 - (await settled(ws.id, id)).balance;
    expect(reservedCredits).toBe(creditsAtTerms(estUsd, terms));
    expect(expected).toBeLessThan(reservedCredits);
    await seal((await loadJob(id))!, report(0, reported));
    const after = await settled(ws.id, id);
    expect(Number(after.meter.engine_cost_usd)).toBeCloseTo(reported, 10);
    expect(Number(after.meter.billed_credits)).toBe(expected);
    expect(after.debit).toBe(expected);
    expect(after.balance).toBe(100 - expected);
    expect(after.meter.overrun_usd).toBeNull();
    expect(Number(after.row.cost_usd)).toBeCloseTo(reported, 10);
  });
});

/* Every workspace runs on the platform's engines (lib/platformSpend.ts); only the house is billed nothing. Its sound
   is capped the same way: no credits either way, and what passed the reservation still counts as the platform's. */
test("the house's sound is billed nothing and settles at its reservation, the rest the platform's", async () => {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  const { loadJob, seal } = await import("../../lib/renderWork");
  const { usdForCredits } = await import("../../lib/elevenlabs");
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'owner',0,0)",
    args: [HOUSE_WORKSPACE_ID, "house", "House", `file:${path.join(dir, "house.db")}`],
  });
  const house = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [HOUSE_WORKSPACE_ID] })).rows[0]);
  const id = "sound-house";
  const estCredits = 200;
  const reserved = usdForCredits(estCredits, null);
  const reported = usdForCredits(estCredits * 20, "creator");
  expect(reported).toBeGreaterThan(reserved);
  await runInTenant(house, async () => {
    await ready();
    await db().execute({
      sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_at,updated_at) VALUES(?,'audio','eleven_sfx','rain',?,'running',?,?)",
      args: [id, JSON.stringify({ task: "sound", estCredits }), Date.now(), Date.now()],
    });
    await reserveGenerationSpend({ id, kind: "audio", engine: "elevenlabs", model: "eleven_sfx", status: "running", engineCostUsd: reserved });
    await seal((await loadJob(id))!, report(estCredits * 20));
    const after = await settled(HOUSE_WORKSPACE_ID, id);
    expect(after.meter.status).toBe("succeeded");
    expect(Number(after.meter.billed_credits)).toBe(0);
    expect(after.debit).toBe(0);
    expect(Number(after.meter.engine_cost_usd)).toBeCloseTo(reserved, 10);
    expect(Number(after.meter.overrun_usd)).toBeCloseTo(reported - reserved, 10);
  });
});
