import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Text jobs nothing will finish are refunded by the cron's pass
 * (lib/paidText.ts reconcilePaidTextJobs, app/api/cron/sync): a provider call
 * cut off (`uncertain`, its estimate billed) and a process killed mid-call
 * (`running`, its estimate reserved). Once, only when no request can still be
 * answering, and never a job whose answer was delivered.
 */
const dir = mkdtempSync(path.join(tmpdir(), "paid-text-reconcile-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.PLATFORM_ALLOWANCE_USD;

const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };
const WRITER = "anthropic/claude-haiku-4.5";
const MODEL = { id: WRITER, name: "Writer", owner: "anthropic", type: "language" as const, description: "", contextWindow: 100000, maxTokens: 5000, pricing: { input: "0.000001", output: "0.000002" } };
const OLD = 31 * 60_000;

type Submit = () => Promise<{ ok: boolean; status: number; text: string }>;
const cutOff: Submit = async () => ({ ok: false, status: 504, text: "" });
/** A provider that never answers: the process "dies" with the job running and its estimate reserved. */
const killed: Submit = () => new Promise(() => {});
const answers: Submit = async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "A lone tree in steady rain." } }], usage: { cost: 0.0004 } }) });

/** A provider whose answer the test releases when it likes: a call that answers after the pass has run. */
function late() {
  let answer: (reply: { ok: boolean; status: number; text: string }) => void = () => {};
  const submit: Submit = () => new Promise((resolve) => { answer = resolve; });
  return { submit, answer: (reply: { ok: boolean; status: number; text: string }) => answer(reply) };
}

async function job(id: string, submit: Submit, inFlight = submit === killed): Promise<{ outcome: Promise<unknown> }> {
  const { runPaidText } = await import("../../lib/paidText");
  const run = runPaidText({ id, model: WRITER, messages: [{ role: "user", content: "a tree in rain" }], maxTokens: 400, kind: "enhance", mock: "prompt", createdBy: "owner" }, { model: MODEL as never, submit });
  const outcome = run.then(() => null, (error: unknown) => error);
  if (inFlight) {
    const { db } = await import("../../lib/db");
    for (let i = 0; i < 200; i++) {
      const row = (await db().execute({ sql: "SELECT status FROM paid_text_jobs WHERE id=?", args: [id] }).catch(() => ({ rows: [] }))).rows[0];
      if (row?.status === "running") return { outcome };
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the job never started");
  }
  await outcome;
  return { outcome };
}

async function age(id: string, ms = OLD) {
  const { db } = await import("../../lib/db");
  await db().execute({ sql: "UPDATE paid_text_jobs SET updated_at=updated_at-?, created_at=created_at-? WHERE id=?", args: [ms, ms, id] });
}

async function state(ws: string, id: string) {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const job = (await db().execute({ sql: "SELECT status FROM paid_text_jobs WHERE id=?", args: [id] })).rows[0];
  const meter = (await platformDb().execute({ sql: "SELECT status,billed_credits,updated_at FROM meter_events WHERE workspace_id=? AND id=?", args: [ws, id] })).rows[0];
  const debit = (await platformDb().execute({ sql: "SELECT credits FROM billing_debits WHERE workspace_id=? AND event_id=?", args: [ws, id] })).rows[0];
  return { job: String(job?.status), meter: String(meter?.status), billed: Number(meter?.billed_credits), debit: Number(debit?.credits ?? 0), meterUpdatedAt: Number(meter?.updated_at) };
}

async function balance(ws: string) {
  const { billingStateFor } = await import("../../lib/billingLedger");
  return (await billingStateFor(ws)).credits.balance;
}

async function inWorkspace(ws: string, fn: () => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`],
  });
  await grantCredits(ws, 1000, "Test", "owner", "manual");
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  await runInTenant(row, async () => { await ready(); await fn(); }, OWNER);
}

test("an old cut-off job is refunded once: its billed estimate comes back and a second pass changes nothing", async () => {
  await inWorkspace("ws_ptr_uncertain", async () => {
    const { reconcilePaidTextJobs } = await import("../../lib/paidText");
    const before = await balance("ws_ptr_uncertain");
    await job("text_uncertain", cutOff);
    expect(await state("ws_ptr_uncertain", "text_uncertain")).toMatchObject({ job: "uncertain", meter: "failed", billed: 1, debit: 1 });
    expect(await balance("ws_ptr_uncertain")).toBe(before - 1);
    await age("text_uncertain");

    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 1, released: 0, failed: 0 });
    const settled = await state("ws_ptr_uncertain", "text_uncertain");
    expect(settled).toMatchObject({ job: "refunded", meter: "failed", billed: 0, debit: 0 });
    expect(await balance("ws_ptr_uncertain")).toBe(before);

    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });
    expect(await state("ws_ptr_uncertain", "text_uncertain")).toEqual(settled);
    expect(await balance("ws_ptr_uncertain")).toBe(before);
  });
});

test("an old job killed mid-call has its reservation released once", async () => {
  await inWorkspace("ws_ptr_running", async () => {
    const { reconcilePaidTextJobs } = await import("../../lib/paidText");
    const before = await balance("ws_ptr_running");
    await job("text_running", killed);
    expect(await state("ws_ptr_running", "text_running")).toMatchObject({ job: "running", meter: "running", billed: 1 });
    await age("text_running");

    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 1, failed: 0 });
    expect(await state("ws_ptr_running", "text_running")).toMatchObject({ job: "refunded", meter: "failed", billed: 0, debit: 0 });
    expect(await balance("ws_ptr_running")).toBe(before);
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });
  });
});

test("a recent job and a delivered one are left alone", async () => {
  await inWorkspace("ws_ptr_untouched", async () => {
    const { reconcilePaidTextJobs } = await import("../../lib/paidText");
    await job("text_recent", cutOff);
    /* Inside the window: a request could still be answering it. */
    await age("text_recent", 20 * 60_000);
    await job("text_delivered", answers);
    await age("text_delivered");
    const recent = await state("ws_ptr_untouched", "text_recent");
    const delivered = await state("ws_ptr_untouched", "text_delivered");
    expect(delivered).toMatchObject({ job: "succeeded", meter: "succeeded", billed: 1 });

    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });
    expect(await state("ws_ptr_untouched", "text_recent")).toEqual(recent);
    expect(recent).toMatchObject({ job: "uncertain", billed: 1 });
    expect(await state("ws_ptr_untouched", "text_delivered")).toEqual(delivered);
  });
});

test("two passes at once settle a job once", async () => {
  await inWorkspace("ws_ptr_concurrent", async () => {
    const { reconcilePaidTextJobs } = await import("../../lib/paidText");
    const before = await balance("ws_ptr_concurrent");
    await job("text_a", cutOff);
    await job("text_b", killed);
    await age("text_a");
    await age("text_b");

    const passes = await Promise.all([reconcilePaidTextJobs(), reconcilePaidTextJobs(), reconcilePaidTextJobs()]);
    expect(passes.reduce((n, p) => n + p.refunded, 0)).toBe(1);
    expect(passes.reduce((n, p) => n + p.released, 0)).toBe(1);
    expect(await state("ws_ptr_concurrent", "text_a")).toMatchObject({ job: "refunded", billed: 0, debit: 0 });
    expect(await state("ws_ptr_concurrent", "text_b")).toMatchObject({ job: "refunded", billed: 0, debit: 0 });
    expect(await balance("ws_ptr_concurrent")).toBe(before);
  });
});

test("the cron heartbeat runs the pass, and the interrupted reply says what now happens to its credits", () => {
  const cron = readFileSync("app/api/cron/sync/route.ts", "utf8");
  expect(cron).toContain('await stage("paid_text", async () => {');
  expect(cron).toContain("reconcilePaidTextJobs({ limit: 10, deadlineAt })");
  expect(cron).toContain('if (report.failed) throw new Error("PAID_TEXT_RECONCILIATION_FAILED");');
  const paidText = readFileSync("lib/paidText.ts", "utf8");
  expect(paidText).not.toContain("Its credits remain reserved");
  expect(paidText).not.toContain("within the hour");
  /* On credits the estimate comes back; on the workspace's own key nothing was charged in credits, so nothing is promised back. */
  expect(paidText).toContain('? "its estimated credits are returned to your balance automatically, usually within a few hours"');
  expect(paidText).toContain(': "nothing more is charged";');
  expect(paidText).toContain("`The text request was interrupted after submission. It will not be sent again, and ${afterwards}.`");
});

test("a provider that answers after the pass refunded its job does not charge it again, success or failure", async () => {
  await inWorkspace("ws_ptr_late", async () => {
    const { reconcilePaidTextJobs } = await import("../../lib/paidText");
    const before = await balance("ws_ptr_late");
    const ok = late();
    const okRun = await job("text_late_ok", ok.submit, true);
    const bad = late();
    const badRun = await job("text_late_bad", bad.submit, true);
    await age("text_late_ok");
    await age("text_late_bad");
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 2, failed: 0 });
    const refunded = { job: "refunded", meter: "failed", billed: 0, debit: 0 };
    expect(await state("ws_ptr_late", "text_late_ok")).toMatchObject(refunded);

    ok.answer({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "A lone tree in steady rain." } }], usage: { cost: 0.0004 } }) });
    expect(String(await okRun.outcome)).toContain("answered too late");
    bad.answer({ ok: false, status: 504, text: "" });
    expect(String(await badRun.outcome)).toContain("uncertain result");

    expect(await state("ws_ptr_late", "text_late_ok")).toMatchObject(refunded);
    expect(await state("ws_ptr_late", "text_late_bad")).toMatchObject(refunded);
    expect(await balance("ws_ptr_late")).toBe(before);
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });
  });
});

test("a job whose provider answer is saved for review is left for review", async () => {
  await inWorkspace("ws_ptr_review", async () => {
    const { reconcilePaidTextJobs } = await import("../../lib/paidText");
    const { db } = await import("../../lib/db");
    await job("text_review", cutOff);
    /* As the direct-usage check leaves it: the paid answer saved, the job uncertain, its estimate billed. */
    await db().execute({ sql: "UPDATE paid_text_jobs SET response_json=? WHERE id=?", args: [JSON.stringify({ choices: [] }), "text_review"] });
    await age("text_review");
    const held = await state("ws_ptr_review", "text_review");
    expect(held).toMatchObject({ job: "uncertain", billed: 1 });
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });
    expect(await state("ws_ptr_review", "text_review")).toEqual(held);
  });
});

test("a pass that settled the meter but could not mark the job is finished by a later pass, once its lease has run out", async () => {
  await inWorkspace("ws_ptr_partial", async () => {
    const { reconcilePaidTextJobs } = await import("../../lib/paidText");
    const { db } = await import("../../lib/db");
    const before = await balance("ws_ptr_partial");
    await job("text_partial", cutOff);
    await age("text_partial");

    const client = db();
    const execute = client.execute.bind(client);
    client.execute = ((statement: Parameters<typeof execute>[0]) => {
      const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
      if (sql.includes("SET status='refunded'")) return Promise.reject(new Error("database went away"));
      return execute(statement);
    }) as typeof client.execute;
    try {
      expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 1 });
    } finally {
      client.execute = execute;
    }
    /* The estimate is already back; the job still reads uncertain under the dead pass's lease. */
    expect(await state("ws_ptr_partial", "text_partial")).toMatchObject({ job: "uncertain", meter: "failed", billed: 0, debit: 0 });
    expect(await balance("ws_ptr_partial")).toBe(before);
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 0, released: 0, failed: 0 });

    await db().execute({ sql: "UPDATE paid_text_jobs SET reconcile_lease=? WHERE id=?", args: [Date.now() - 1, "text_partial"] });
    expect(await reconcilePaidTextJobs()).toEqual({ refunded: 1, released: 0, failed: 0 });
    expect(await state("ws_ptr_partial", "text_partial")).toMatchObject({ job: "refunded", meter: "failed", billed: 0, debit: 0 });
    expect(await balance("ws_ptr_partial")).toBe(before);
  });
});
