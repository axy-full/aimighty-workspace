import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

/**
 * Renders at risk (owner's decision, 9 October 2026): any paid render with no
 * stored copy an hour on emails the platform owner, once per newly at-risk
 * render and at most daily while any remain, and is a line on the admin desk
 * (lib/rendersAtRisk.ts). Local temporary databases only; ENGINE_MOCK; mail
 * goes to a local stand-in through RESEND_BASE_URL (lib/mail.ts), never out.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-renders-at-risk-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "legacy.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
/* The mail seam: a key and sender that only the local stand-in ever sees. Set before anything can send. */
process.env.RESEND_BASE_URL = "http://127.0.0.1:9";
process.env.RESEND_API_KEY = "re_test_local_only";
process.env.MAIL_FROM = "Particl <hello@example.invalid>";
process.env.SUPER_ADMIN_EMAIL = "platform-owner@example.invalid";

test.describe.configure({ mode: "serial" });

type Sent = { to: string[]; subject: string; text: string; html: string };
const sent: Sent[] = [];
let failSends = false;
let onSend: (() => Promise<void>) | null = null;
let sink: Server;

test.beforeAll(async () => {
  sink = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (onSend) await onSend();
    if (failSends) { res.writeHead(422, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "stand-in refused" })); return; }
    sent.push(JSON.parse(body) as Sent);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `mail_${sent.length}` }));
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const address = sink.address();
  if (!address || typeof address === "string") throw new Error("no sink port");
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>((resolve) => sink.close(() => resolve())); });

const jsonLines = (lines: string[]) => lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const MIN = 60_000;
const HOUR = 60 * MIN;
const OWNER = { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null };

async function workspace(id: string, name: string) {
  const { platformDb, platformReady, getWorkspace } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,'owner',1,0,0,20,200)`,
    args: [id, id, name, `file:${path.join(dir, `${id}.db`)}`],
  });
  return (await getWorkspace(id))!;
}

async function inTenant<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const { getWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = (await getWorkspace(id))!;
  return runInTenant(ws, async () => {
    const { ready } = await import("../../lib/db");
    await ready();
    return fn();
  }, { user: OWNER } as never);
}

async function put(id: string, o: { status: string; settledAt?: number; createdAt: number; stored?: boolean; deleted?: boolean; provider?: string; params?: Record<string, unknown> }) {
  const { db } = await import("../../lib/db");
  await db().execute({
    sql: `INSERT INTO generations(id,kind,model,prompt,params,status,provider,source_url,stored_url,deleted,created_by,created_at,updated_at,settled_at)
          VALUES(?,'video','seedance-test','A harbour at dawn',?,?,?,?,?,?,'owner',?,?,?)`,
    args: [id, JSON.stringify(o.params ?? {}), o.status, o.provider ?? "byteplus",
      "https://provider.example/out.mp4?sig=SECRET", o.stored ? `ws/generations/${id}.mp4` : null, o.deleted ? 1 : 0,
      o.createdAt, o.settledAt ?? o.createdAt, o.settledAt ?? null],
  });
}

const visit = async (id: string, at: number) => inTenant(id, async () => (await import("../../lib/rendersAtRisk")).recordRendersAtRisk({ at }));
const alert = async (at: number) => (await import("../../lib/rendersAtRisk")).alertRendersAtRisk({ at });
const desk = async (at?: number) => (await import("../../lib/rendersAtRisk")).rendersAtRiskDesk({ at });

/* Well in the past, so the cron test (on the real clock) never re-reads these as new. */
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

test("none at risk: nothing recorded, no email", async () => {
  await workspace("ws_quiet", "Quiet Studio");
  await inTenant("ws_quiet", async () => {
    await put("q_stored", { status: "succeeded", createdAt: T0 - 5 * HOUR, settledAt: T0 - 5 * HOUR, stored: true });
    await put("q_failed", { status: "failed", createdAt: T0 - 5 * HOUR, settledAt: T0 - 5 * HOUR });
  });
  expect(await visit("ws_quiet", T0)).toEqual({ open: 0 });
  expect(await alert(T0)).toEqual({ open: 0, sent: null });
  expect(sent).toHaveLength(0);
  expect(await desk()).toMatchObject({ count: 0, oldestSince: null, renders: [] });
  /* The partial index the check reads by is in the workspace's database. */
  await inTenant("ws_quiet", async () => {
    const { db } = await import("../../lib/db");
    const index = (await db().execute("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_gen_unstored'")).rows[0];
    expect(String(index?.sql)).toMatch(/ON generations\(created_at\) WHERE stored_url IS NULL AND deleted=0/);
  });
});

test("one email per newly at-risk set, none 10 minutes later, one more for a new render, a stored one drops out, a daily reminder", async () => {
  await workspace("ws_a", "Harbour Films");
  await inTenant("ws_a", async () => {
    /* At risk: succeeded two hours ago, never stored. Its save error names a signed link, which must not travel. */
    await put("g_old", { status: "succeeded", createdAt: T0 - 3 * HOUR, settledAt: T0 - 2 * HOUR,
      params: { storeFailedAt: T0 - 2 * HOUR, storeError: "fetch failed (502)" } });
    /* Succeeded 30 minutes ago: not yet an hour. */
    await put("g_recent", { status: "succeeded", createdAt: T0 - 40 * MIN, settledAt: T0 - 30 * MIN });
    /* Stored, deleted, failed, still running without a provider success: never at risk. */
    await put("g_stored", { status: "succeeded", createdAt: T0 - 5 * HOUR, settledAt: T0 - 5 * HOUR, stored: true });
    await put("g_deleted", { status: "succeeded", createdAt: T0 - 5 * HOUR, settledAt: T0 - 5 * HOUR, deleted: true });
    await put("g_failed", { status: "failed", createdAt: T0 - 5 * HOUR, settledAt: T0 - 5 * HOUR });
    await put("g_running", { status: "running", createdAt: T0 - 5 * HOUR, provider: "fal" });
  });

  expect(await visit("ws_a", T0)).toEqual({ open: 1 });
  expect(await alert(T0)).toEqual({ open: 1, sent: "new" });
  expect(sent).toHaveLength(1);
  const first = sent[0];
  expect(first.to).toEqual(["platform-owner@example.invalid"]);
  expect(first.subject).toBe("Particl: 1 render with no stored copy");
  expect(first.text).toContain("Harbour Films (ws_a) · g_old · byteplus seedance-test · 2 h · last save error: fetch failed (502)");
  expect(first.text).toContain("New since the last email: 1.");
  for (const body of [first.text, first.html]) {
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("A harbour at dawn");
    expect(body).not.toContain("g_recent");
  }

  /* The next sweep, 10 minutes on: the same set, no row written, no email. */
  /* A counter the test adds to its own temporary database: every row written to the table. */
  const { platformDb } = await import("../../lib/platform");
  await platformDb().batch([
    "CREATE TABLE IF NOT EXISTS test_row_writes(n INTEGER NOT NULL)",
    "INSERT INTO test_row_writes(n) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM test_row_writes)",
    "CREATE TRIGGER IF NOT EXISTS test_at_risk_insert AFTER INSERT ON render_at_risk BEGIN UPDATE test_row_writes SET n=n+1; END",
    "CREATE TRIGGER IF NOT EXISTS test_at_risk_update AFTER UPDATE ON render_at_risk BEGIN UPDATE test_row_writes SET n=n+1; END",
  ], "write");
  const writes = async () => Number((await platformDb().execute("SELECT n FROM test_row_writes")).rows[0].n);
  const written = await writes();
  expect(await visit("ws_a", T0 + 10 * MIN)).toEqual({ open: 1 });
  expect(await writes()).toBe(written);
  expect(await alert(T0 + 10 * MIN)).toEqual({ open: 1, sent: null });
  expect(sent).toHaveLength(1);

  /* An hour on, the recent render is at risk too: one more email, listing the new one first. */
  expect(await visit("ws_a", T0 + 40 * MIN)).toEqual({ open: 2 });
  expect(await alert(T0 + 40 * MIN)).toEqual({ open: 2, sent: "new" });
  expect(sent).toHaveLength(2);
  expect(sent[1].subject).toBe("Particl: 2 renders with no stored copy");
  expect(sent[1].text).toContain("New since the last email: 1.");
  expect(sent[1].text.indexOf("g_recent")).toBeLessThan(sent[1].text.indexOf("g_old"));
  expect(await alert(T0 + 50 * MIN)).toEqual({ open: 2, sent: null });
  expect(sent).toHaveLength(2);

  /* The admin line: the count and the oldest. */
  const { atRiskLine } = await import("../../lib/rendersAtRiskText");
  const two = await desk(T0 + 60 * MIN);
  expect(two).toMatchObject({ count: 2, oldestSince: T0 - 2 * HOUR, lastMailAt: T0 + 40 * MIN });
  expect(two.renders.map((r) => r.generationId)).toEqual(["g_old", "g_recent"]);
  expect(JSON.stringify(two)).not.toMatch(/https?:\/\/|SECRET|harbour at dawn/);
  expect(atRiskLine(two, T0 + 60 * MIN)).toBe("2 renders with no stored copy · oldest 3 h");

  /* The cron saves the old one: it drops out of the desk and of every later email. */
  await inTenant("ws_a", async () => {
    const { db } = await import("../../lib/db");
    await db().execute("UPDATE generations SET stored_url='ws/generations/g_old.mp4' WHERE id='g_old'");
  });
  expect(await visit("ws_a", T0 + 60 * MIN)).toEqual({ open: 1 });
  expect(await desk(T0 + 60 * MIN)).toMatchObject({ count: 1, lost: 0, oldestSince: T0 - 30 * MIN });
  expect(await alert(T0 + 60 * MIN)).toEqual({ open: 1, sent: null });
  expect(sent).toHaveLength(2);

  /* A day after the last email, while one remains: one reminder, and not another ten minutes later. */
  expect(await alert(T0 + 40 * MIN + 23 * HOUR)).toEqual({ open: 1, sent: null });
  expect(await visit("ws_a", T0 + 40 * MIN + 24 * HOUR)).toEqual({ open: 1 });
  expect(await alert(T0 + 40 * MIN + 24 * HOUR)).toEqual({ open: 1, sent: "reminder" });
  expect(sent).toHaveLength(3);
  expect(sent[2].subject).toBe("Particl reminder: 1 render still with no stored copy");
  expect(sent[2].text).toContain("g_recent");
  expect(sent[2].text).not.toContain("g_old");
  expect(await alert(T0 + 50 * MIN + 24 * HOUR)).toEqual({ open: 1, sent: null });
  expect(sent).toHaveLength(3);

  /* Deleted by the person: out too, and with none left, no email ever again. */
  await inTenant("ws_a", async () => {
    const { db } = await import("../../lib/db");
    await db().execute("UPDATE generations SET deleted=1 WHERE id='g_recent'");
  });
  expect(await visit("ws_a", T0 + 3 * 24 * HOUR)).toEqual({ open: 0 });
  expect(await alert(T0 + 3 * 24 * HOUR)).toEqual({ open: 0, sent: null });
  expect(sent).toHaveLength(3);
  expect(atRiskLine(await desk(T0 + 3 * 24 * HOUR), T0 + 3 * 24 * HOUR)).toBe("No render is waiting for a stored copy.");
});

test("a provider-finished fal take whose save failed is at risk an hour after the first failure, marked not billed; the note keeps no link", async () => {
  await workspace("ws_fal", "Fal Studio");
  const before = sent.length;
  await inTenant("ws_fal", async () => {
    await put("f_failed_save", { status: "running", createdAt: T0 + 10 * HOUR, provider: "fal" });
    await put("f_working", { status: "running", createdAt: T0 + 10 * HOUR, provider: "fal" });
    const { noteStoreFailure, storeErrorText } = await import("../../lib/storeFailure");
    await noteStoreFailure("f_failed_save", new Error("download failed: https://v3.fal.media/files/abc.mp4?token=SECRET Bearer SECRET2"), T0 + 11 * HOUR);
    /* A second failure keeps the first time and the latest words. */
    await noteStoreFailure("f_failed_save", new Error("storage refused (503)"), T0 + 11 * HOUR + 10 * MIN);
    const { db } = await import("../../lib/db");
    const params = JSON.parse(String((await db().execute("SELECT params FROM generations WHERE id='f_failed_save'")).rows[0].params));
    expect(params).toMatchObject({ storeFailedAt: T0 + 11 * HOUR, storeError: "storage refused (503)" });
    expect(storeErrorText(new Error("x https://a.example/b?sig=1 Bearer abc key=zzz"))).toBe("x [link] Bearer [hidden] [hidden]");
  });
  expect(await visit("ws_fal", T0 + 11 * HOUR + 30 * MIN)).toEqual({ open: 0 });
  expect(await visit("ws_fal", T0 + 12 * HOUR)).toEqual({ open: 1 });
  expect((await desk(T0 + 12 * HOUR)).renders).toEqual([expect.objectContaining({ lost: false, generationId: "f_failed_save", provider: "fal", billed: false, since: T0 + 11 * HOUR, lastError: "storage refused (503)" })]);
  expect(await alert(T0 + 12 * HOUR)).toEqual({ open: 1, sent: "new" });
  expect(sent).toHaveLength(before + 1);
  expect(sent.at(-1)!.text).toContain("Fal Studio (ws_fal) · f_failed_save · fal seedance-test · 1 h · provider finished, not billed yet · last save error: storage refused (503)");
  expect(sent.at(-1)!.text).not.toMatch(/SECRET|https?:\/\//);
  /* Stored at last (the fal path writes stored_url and succeeded together): out. */
  await inTenant("ws_fal", async () => {
    const { db } = await import("../../lib/db");
    await db().execute("UPDATE generations SET status='succeeded', stored_url='ws/generations/f_failed_save.mp4' WHERE id='f_failed_save'");
  });
  expect(await visit("ws_fal", T0 + 13 * HOUR)).toEqual({ open: 0 });
});

const DAY = 24 * HOUR;
const retire = async (id: string, at: number) => {
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute({ sql: "UPDATE workspaces SET deleted_at=? WHERE id=?", args: [at, id] });
  expect(await alert(at)).toMatchObject({ sent: null });
};

test("first run with historic renders: one email, the lost ones labelled, no reminder about them; reminders stop when only lost ones remain", async () => {
  const TA = T0 + 20 * DAY;
  await workspace("ws_hist", "Archive Studio");
  await inTenant("ws_hist", async () => {
    await put("h_lost_10d", { status: "succeeded", createdAt: TA - 10 * DAY, settledAt: TA - 10 * DAY });
    await put("h_lost_5d", { status: "succeeded", createdAt: TA - 5 * DAY, settledAt: TA - 5 * DAY });
    await put("h_window", { status: "succeeded", createdAt: TA - 2 * HOUR, settledAt: TA - 90 * MIN });
  });
  const before = sent.length;
  expect(await visit("ws_hist", TA)).toEqual({ open: 3 });
  expect(await alert(TA)).toEqual({ open: 3, sent: "new" });
  expect(sent).toHaveLength(before + 1);
  const first = sent.at(-1)!;
  expect(first.subject).toBe("Particl: 3 renders with no stored copy");
  const line = (id: string, text: string) => text.split("\n").find((l) => l.includes(id)) ?? "";
  expect(line("h_lost_10d", first.text)).toContain("· 10 d · lost: no longer retried");
  expect(line("h_lost_5d", first.text)).toContain("· 5 d · lost: no longer retried");
  expect(line("h_window", first.text)).not.toContain("lost");
  expect(first.text).toContain('2 renders marked "lost" are past the 3-day window. This email is the only one about them.');
  expect(first.text).toContain("The cron tries to save a render every 10 minutes until 3 days after the render was created. A fal take is tried until fal no longer has the job.");
  expect(await alert(TA + 10 * MIN)).toEqual({ open: 3, sent: null });

  /* A day on: the reminder names only the render still inside its window. */
  expect(await visit("ws_hist", TA + DAY)).toEqual({ open: 3 });
  expect(await alert(TA + DAY)).toEqual({ open: 3, sent: "reminder" });
  const reminder = sent.at(-1)!;
  expect(reminder.subject).toBe("Particl reminder: 1 render still with no stored copy");
  expect(reminder.text).toContain("h_window");
  expect(reminder.text).not.toMatch(/h_lost_/);
  expect(reminder.text).toContain("2 renders already reported as lost are not in this email.");

  /* The desk still lists all three, the lost ones labelled. */
  const { atRiskLine, atRiskState } = await import("../../lib/rendersAtRiskText");
  const view = await desk(TA + DAY);
  expect(view).toMatchObject({ count: 3, lost: 2 });
  expect(view.renders.filter((r) => r.lost).map((r) => r.generationId)).toEqual(["h_lost_10d", "h_lost_5d"]);
  expect(atRiskState(view.renders[0])).toBe(" · lost: no longer retried");
  expect(atRiskLine({ count: 3, lost: 2, oldestSince: TA - 10 * DAY }, TA + DAY)).toBe("3 renders with no stored copy · 2 lost · oldest 11 d");

  /* The one inside its window is saved: only lost ones remain, and no reminder comes again. */
  await inTenant("ws_hist", async () => {
    const { db } = await import("../../lib/db");
    await db().execute("UPDATE generations SET stored_url='ws/generations/h_window.mp4' WHERE id='h_window'");
  });
  expect(await visit("ws_hist", TA + DAY + HOUR)).toEqual({ open: 2 });
  const quiet = sent.length;
  for (const later of [2 * DAY + HOUR, 3 * DAY, 10 * DAY]) {
    expect(await visit("ws_hist", TA + later)).toEqual({ open: 2 });
    expect(await alert(TA + later)).toEqual({ open: 2, sent: null });
  }
  expect(sent).toHaveLength(quiet);
  expect((await desk(TA + 10 * DAY)).renders.map((r) => [r.generationId, r.lost])).toEqual([["h_lost_10d", true], ["h_lost_5d", true]]);

  /* Rows that dropped out are deleted 30 days on. */
  await retire("ws_hist", TA + 11 * DAY);
  const { platformDb } = await import("../../lib/platform");
  const rows = async () => Number((await platformDb().execute("SELECT COUNT(*) AS n FROM render_at_risk WHERE workspace_id='ws_hist'")).rows[0].n);
  expect(await rows()).toBe(3);
  /* 29 days after the workspace went: the two lost rows stay; the one saved on day 1 dropped out 39 days ago and is gone. */
  await alert(TA + 11 * DAY + 29 * DAY);
  expect(await rows()).toBe(2);
  await alert(TA + 11 * DAY + 31 * DAY);
  expect(await rows()).toBe(0);
});

test("a render that passes its 3-day window: one lost mention, then silence", async () => {
  const TB = T0 + 80 * DAY;
  await workspace("ws_pass", "Window Studio");
  await inTenant("ws_pass", async () => put("p_take", { status: "succeeded", createdAt: TB - 2 * HOUR, settledAt: TB - 2 * HOUR }));
  const before = sent.length;
  expect(await visit("ws_pass", TB)).toEqual({ open: 1 });
  expect(await alert(TB)).toEqual({ open: 1, sent: "new" });
  expect(sent.at(-1)!.text).not.toContain("lost");
  expect(await alert(TB + DAY)).toEqual({ open: 1, sent: "reminder" });
  expect(await alert(TB + 2 * DAY)).toEqual({ open: 1, sent: "reminder" });
  /* Created TB − 2 h: its window closes at TB + 70 h. */
  expect(await visit("ws_pass", TB + 71 * HOUR)).toEqual({ open: 1 });
  expect(await alert(TB + 71 * HOUR)).toEqual({ open: 1, sent: "new" });
  const lost = sent.at(-1)!;
  expect(lost.subject).toBe("Particl: 1 render with no stored copy");
  expect(lost.text).toContain("p_take");
  expect(lost.text).toContain("lost: no longer retried");
  expect(lost.text).toContain('1 render marked "lost" is past the 3-day window. This email is the only one about it.');
  expect(sent).toHaveLength(before + 4);
  for (const later of [71 * HOUR + 10 * MIN, 4 * DAY, 5 * DAY, 30 * DAY]) {
    expect(await visit("ws_pass", TB + later)).toEqual({ open: 1 });
    expect(await alert(TB + later)).toEqual({ open: 1, sent: null });
  }
  expect(sent).toHaveLength(before + 4);
  await retire("ws_pass", TB + 31 * DAY);
});

test("an email marks only the renders it names: past the first 20, the rest go in the next sweep's email", async () => {
  const TC = T0 + 150 * DAY;
  await workspace("ws_many", "Many Studio");
  await inTenant("ws_many", async () => {
    for (let i = 0; i < 22; i++)
      await put(`m_${String(i).padStart(2, "0")}`, { status: "succeeded", createdAt: TC - 3 * HOUR + i * MIN, settledAt: TC - 2 * HOUR + i * MIN });
  });
  const before = sent.length;
  expect(await visit("ws_many", TC)).toEqual({ open: 22 });
  expect(await alert(TC)).toEqual({ open: 22, sent: "new" });
  expect(sent.at(-1)!.text).toContain("…and 2 more.");
  expect(sent.at(-1)!.text).not.toMatch(/m_2[01]/);
  const { platformDb } = await import("../../lib/platform");
  const unmarked = async () => (await platformDb().execute("SELECT generation_id FROM render_at_risk WHERE workspace_id='ws_many' AND alerted_at IS NULL ORDER BY generation_id")).rows.map((r) => r.generation_id);
  expect(await unmarked()).toEqual(["m_20", "m_21"]);
  expect(await alert(TC + 10 * MIN)).toEqual({ open: 22, sent: "new" });
  const second = sent.at(-1)!.text;
  expect(second).toContain("New since the last email: 2.");
  expect(second.indexOf("m_20")).toBeLessThan(second.indexOf("m_00"));
  expect(await unmarked()).toEqual([]);
  expect(await alert(TC + 20 * MIN)).toEqual({ open: 22, sent: null });
  expect(sent).toHaveLength(before + 2);
  await retire("ws_many", TC + HOUR);
});

test("the fal collector notes a failed save on the take it leaves running (mocked poll, nothing sent)", async () => {
  await workspace("ws_falsync", "Fal Sync");
  await inTenant("ws_falsync", async () => {
    await put("fs_take", { status: "running", createdAt: Date.now() - 5 * MIN, provider: "fal",
      params: { falRequestId: "req-local", falModel: "fal-ai/kling-video/v3/standard/text-to-video" } });
    const { getGeneration } = await import("../../lib/jobs");
    const { syncFalVideo } = await import("../../lib/falVideo");
    const { engineFor } = await import("../../lib/engines");
    const engine = engineFor("fal");
    const original = engine.poll;
    const quiet = console.error;
    console.error = () => {};
    try {
      /* The provider says it finished; the "file" is a fixture that does not exist, so the save fails. */
      engine.poll = async () => ({ status: "succeeded", videoUrl: "fixture:missing.mp4", totalTokens: null, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {} });
      await syncFalVideo((await getGeneration("fs_take"))!);
    } finally { engine.poll = original; console.error = quiet; }
    const { db } = await import("../../lib/db");
    const row = (await db().execute("SELECT status, stored_url, params FROM generations WHERE id='fs_take'")).rows[0];
    expect(row).toMatchObject({ status: "running", stored_url: null });
    const params = JSON.parse(String(row.params));
    expect(typeof params.storeFailedAt).toBe("number");
    expect(typeof params.storeError).toBe("string");
    expect(params.storeError).not.toMatch(/https?:\/\//);
  });
});

test("a failed send is logged as a JSON line, never throws, and leaves the render to be emailed on the next sweep", async () => {
  await workspace("ws_send", "Send Studio");
  await inTenant("ws_send", async () => put("s_old", { status: "succeeded", createdAt: T0 + 20 * HOUR, settledAt: T0 + 20 * HOUR }));
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { logged.push(String(line)); };
  failSends = true;
  const before = sent.length;
  try {
    expect(await visit("ws_send", T0 + 22 * HOUR)).toEqual({ open: 1 });
    expect(await alert(T0 + 22 * HOUR)).toEqual({ open: 1, sent: null });
  } finally { failSends = false; console.error = original; }
  expect(sent).toHaveLength(before);
  expect(jsonLines(logged)).toContainEqual({ level: "error", event: "renders.at_risk_alert", outcome: "send_failed", kind: "new", open: 1, fresh: 1 });
  /* Ten minutes on the stand-in answers: the alert goes then, once. */
  expect(await alert(T0 + 22 * HOUR + 10 * MIN)).toEqual({ open: 1, sent: "new" });
  expect(sent).toHaveLength(before + 1);
  expect(await alert(T0 + 22 * HOUR + 20 * MIN)).toEqual({ open: 1, sent: null });
  /* A deleted workspace's renders are nobody's to rescue: out, without an email. */
  const { platformDb } = await import("../../lib/platform");
  await platformDb().execute("UPDATE workspaces SET deleted_at=1 WHERE id='ws_send'");
  expect(await alert(T0 + 22 * HOUR + 30 * MIN)).toEqual({ open: 0, sent: null });
});

/* ── The cron sweep: recorded on each visit, alerted under the reconciliation lease, a send failure fails nothing ── */
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name in overrides) return overrides[name];
    throw new Error(`The test must provide ${name}`);
  }, target, target.exports);
  return target.exports as T;
}

test("the cron sweep records and alerts under its lease, and a failing send still leaves the sweep succeeded", async () => {
  await workspace("ws_cron", "Cron Studio");
  await inTenant("ws_cron", async () => put("c_old", { status: "succeeded", createdAt: Date.now() - 3 * HOUR, settledAt: Date.now() - 2 * HOUR }));
  const settings: Record<string, string> = {};
  const done = async () => ({});
  const route = load<{ GET(req: Request): Promise<Response> }>("app/api/cron/sync/route.ts", {
    "@/lib/recovery": { recoveryFence: () => ({ status: async () => ({ state: "open" }) }), recoveryRoute: (h: () => Promise<Response>) => h, reserveRecoveryContinuation: async (_: string, fn: unknown) => fn },
    "@/lib/recoveryDrain": { drainRecoveryJobs: async () => ({}), RECOVERY_DRAIN_WORK_BUDGET_MS: 1 },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) }, after: () => {} },
    "@/lib/db": { db: () => ({ execute: async () => ({ rows: [{ pending: 0, atrisk: 0 }] }) }), ready: async () => {} },
    "@/lib/jobs": { syncPending: async () => ({ failed: 0, deferred: 0 }) },
    "@/lib/identities": { syncTrainingIdentities: async () => ({ failed: 0 }) },
    "@/lib/soulIdentities": { syncSoulIdentities: async () => ({ failed: 0 }) },
    "@/lib/storageCost": { backfillSizes: done },
    "@/lib/settings": { setSetting: async (key: string, value: string) => { settings[key] = value; } },
    /* Real: the workspaces, the tenant, the lease and the alert. */
    "@/lib/platform": await import("../../lib/platform"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/reconciliation": await import("../../lib/reconciliation"),
    "@/lib/rendersAtRisk": await import("../../lib/rendersAtRisk"),
    "@/lib/held": { releaseHeldJobs: done },
    "@/lib/purge": { retireDeletedWorkspaces: async () => ({ failed: 0 }) },
    "@/lib/uploadReservations": { cleanupExpiredUploads: done },
    "@/lib/pipeline/executor": { drainPipelineWakeups: async () => ({ failed: 0 }) },
    "@/lib/higgsfield-consumer/sweep": { sweepConsumerJobs: async () => ({ deferred: false }) },
    "@/lib/higgsfield-consumer/retired": { SIGN_IN_OFF: true },
    "@/lib/workbench/canvas-push": { drainCanvasPushes: done },
    "@/lib/workbench/rig-agent": { drainRigAgentWakeups: done },
    "@/lib/genjutsuVideo": { expireUnansweredCinemaTakes: async () => ({ expired: [] }) },
    "@/lib/paidText": { reconcilePaidTextJobs: async () => ({ refunded: 0, released: 0, failed: 0 }) },
  });
  const { platformDb } = await import("../../lib/platform");
  const { RECONCILIATION_OPERATION } = await import("../../lib/reconciliation");
  const leaseHeld: boolean[] = [];
  onSend = async () => {
    const row = (await platformDb().execute({ sql: "SELECT owner, lease_until FROM operation_leases WHERE name=?", args: [RECONCILIATION_OPERATION] })).rows[0];
    leaseHeld.push(row?.owner != null && Number(row.lease_until) > Date.now());
  };
  const errors: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { errors.push(String(line)); };
  failSends = true;
  const before = sent.length;
  let reply: Response;
  try {
    reply = await route.GET(new Request("http://localhost/api/cron/sync"));
  } finally { failSends = false; console.error = original; }
  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({ ok: true, failed: 0 });
  expect(settings.lastCronStatus).toBe("succeeded");
  expect(sent).toHaveLength(before);
  expect(jsonLines(errors)).toContainEqual(expect.objectContaining({ level: "error", event: "renders.at_risk_alert", outcome: "send_failed" }));
  /* The send was tried while the sweep held its lease. */
  expect(leaseHeld).toEqual([true]);
  expect((await desk()).renders.map((r) => r.generationId)).toContain("c_old");

  /* The next sweep sends it, once; the one after sends nothing. */
  leaseHeld.length = 0;
  expect((await route.GET(new Request("http://localhost/api/cron/sync"))).status).toBe(200);
  expect(sent).toHaveLength(before + 1);
  expect(sent.at(-1)!.text).toContain("Cron Studio (ws_cron) · c_old");
  expect(leaseHeld).toEqual([true]);
  expect((await route.GET(new Request("http://localhost/api/cron/sync"))).status).toBe(200);
  expect(sent).toHaveLength(before + 1);
  onSend = null;
});

test("the admin route answers the platform owner alone, with the count, the oldest and the list", async () => {
  let allowed = false;
  const route = load<{ GET(): Promise<Response> }>("app/api/admin/renders-at-risk/route.ts", {
    "@/lib/recovery": { recoveryRoute: (h: () => Promise<Response>) => h },
    "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    "@/lib/auth": { requireSuperAdmin: async () => allowed ? { user: OWNER } : { response: Response.json({ error: "The platform owner only." }, { status: 403 }) } },
    "@/lib/rendersAtRisk": await import("../../lib/rendersAtRisk"),
  });
  const refused = await route.GET();
  expect(refused.status).toBe(403);
  expect(JSON.stringify(await refused.json())).not.toContain("c_old");
  allowed = true;
  const reply = await route.GET();
  expect(reply.status).toBe(200);
  expect(reply.headers.get("cache-control")).toBe("private, no-store");
  const body = await reply.json();
  expect(body.count).toBeGreaterThan(0);
  expect(typeof body.oldestSince).toBe("number");
  expect(body.renders.map((r: { generationId: string }) => r.generationId)).toContain("c_old");
  /* The card mounts on the platform desk, beside the shared key. */
  expect(readFileSync("app/(app)/admin/page.tsx", "utf8")).toContain("<RendersAtRiskCard />");
});
