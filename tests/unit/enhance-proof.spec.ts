import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * A take is labelled Enhanced only on proof that the enhancer's own paid job ran for exactly the typed words and answered what the
 * take is sent with (lib/enhanceProof.ts), in this workspace's own database and recently. The browser's word is not enough.
 */
const dir = mkdtempSync(path.join(tmpdir(), "enhance-proof-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };

async function inWorkspace(id: string, fn: () => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [id, id, id, `file:${path.join(dir, id + ".db")}`],
  });
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  await runInTenant(row, async () => { await ready(); await fn(); }, OWNER);
}

/** The provider's reply as the job keeps it: a chat completion carrying the enhancer's JSON answer. */
const completion = (prompt: string) => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt }) } }], usage: { cost: 0.0001 } });

async function job(id: string, over: { status?: string; kind?: string; typed: string; answer: string; at?: number }) {
  const { db } = await import("../../lib/db");
  await db().execute(`CREATE TABLE IF NOT EXISTS paid_text_jobs(id TEXT PRIMARY KEY, model TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL, estimate_usd REAL NOT NULL, cost_usd REAL, response_json TEXT, effort TEXT, request_body TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reconcile_lease INTEGER)`);
  const at = over.at ?? Date.now();
  await db().execute({
    sql: "INSERT INTO paid_text_jobs(id,model,kind,status,estimate_usd,request_body,response_json,created_at,updated_at) VALUES(?,?,?,?,0.001,?,?,?,?)",
    args: [id, "m", over.kind ?? "enhance", over.status ?? "succeeded", JSON.stringify({ messages: [{ role: "system", content: "s" }, { role: "user", content: over.typed }] }), over.answer, at, at],
  });
}

test("an enhancement is proved by the enhancer's own succeeded job for those words, answering what the take carries", async () => {
  const { enhancementRan } = await import("../../lib/enhanceProof");
  await inWorkspace("proof-a", async () => {
    await job("t1", { typed: "a kite over the sea", answer: completion("A paper kite drifts over a grey sea at dusk, low sun, slow push-in.") });
    expect(await enhancementRan("a kite over the sea", "A paper kite drifts over a grey sea at dusk, low sun, slow push-in.")).toBe(true);
    /* The words go on a line with more written after them (the composer may add its own): still the enhancer's answer. */
    expect(await enhancementRan("a kite over the sea", "A paper kite drifts over a grey sea at dusk, low sun, slow push-in. Wide lens.")).toBe(true);
    /* Other words typed, or words the enhancer never wrote, are not proved. */
    expect(await enhancementRan("a boat in the rain", "A paper kite drifts over a grey sea at dusk, low sun, slow push-in.")).toBe(false);
    expect(await enhancementRan("a kite over the sea", "Something the person typed afterwards.")).toBe(false);
    expect(await enhancementRan("", "x")).toBe(false);
  });
});

test("a job that failed, is not an enhancement, or is old proves nothing; another workspace's job does not count", async () => {
  const { enhancementRan, ENHANCE_PROOF_WINDOW_MS } = await import("../../lib/enhanceProof");
  const answer = completion("A lone tree stands in steady rain, soft light.");
  await inWorkspace("proof-b", async () => {
    await job("f1", { status: "refused", typed: "a tree in rain", answer });
    await job("f2", { kind: "idea", typed: "a tree in rain", answer });
    await job("f3", { typed: "a tree in rain", answer, at: Date.now() - ENHANCE_PROOF_WINDOW_MS - 60_000 });
    expect(await enhancementRan("a tree in rain", "A lone tree stands in steady rain, soft light.")).toBe(false);
    await job("ok", { typed: "a tree in rain", answer });
    expect(await enhancementRan("a tree in rain", "A lone tree stands in steady rain, soft light.")).toBe(true);
  });
  await inWorkspace("proof-c", async () => {
    expect(await enhancementRan("a tree in rain", "A lone tree stands in steady rain, soft light."), "no job in this workspace").toBe(false);
  });
});
