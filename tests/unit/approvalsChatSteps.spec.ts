import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Atomik chat steps are their own person's (owner, 12 Oct): each person is shown their own steps and nothing of anyone else's (not even a count).
 * Since 21 Oct 2026 that holds for an admin too: "the admin approval rule is retired; every member approves their own spend with their own tap on
 * the quote". Until then an admin was shown another member's step over the workspace's per-shot cap; now no stored rule or cap shows one. Atomik's
 * agent identities see nothing extra. Real temporary databases; sign-in is a fake; nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-approvals-steps-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const T = Date.now().toString(36);
const now = Date.now();
const MODEL = "dreamina-seedance-2-0-260128";
const workspace = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 4, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});
const A = workspace(`ws_stepsa${T}`), B = workspace(`ws_stepsb${T}`);
/* A per-shot cap stored before the rule was retired, between a cheap step (US$0.5 of engine) and a big one (US$40): it used to send the big one to an admin. Synthetic dollars, made up for this test. */
const capBetween = async () => {
  const { billCredits, marginKeyOf } = await import("../../lib/creditTerms");
  return billCredits(0.5, marginKeyOf("video", MODEL)) + 1;
};

async function seed(ws: TenantWorkspace, chats: { id: string; by: string; usd: number; secret: string }[]) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { setSetting } = await import("../../lib/settings");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)", args: [`grant_${ws.id}`, ws.id, 5000, 0] });
  await runInTenant(ws, async () => {
    await ready();
    const user = (id: string, role: string) => `INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES('${id}','${id}@example.invalid','${id}','x','${role}',0)`;
    await db().batch([
      user("u_owner", "admin"), user("u_admin", "admin"), user("u_admin2", "admin"), user("u_a", "member"), user("u_b", "member"),
      { sql: "INSERT INTO projects(id,name,created_at) VALUES('prod_a','Project one',0)", args: [] },
      ...chats.flatMap((c) => [
        { sql: "INSERT INTO atomik_chats(id,project_id,title,status,created_by,created_at,updated_at) VALUES(?,'prod_a',?,'waiting',?,?,?)", args: [c.id, `${c.secret} chat`, c.by, now - 50_000, now - 40_000] },
        { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES(?,?,'user',?,?)", args: [`mu_${c.id}`, c.id, `${c.secret} ask`, now - 50_000] },
        { sql: "INSERT INTO atomik_messages(id,chat_id,role,text,created_at) VALUES(?,?,'assistant','A plan',?)", args: [`ma_${c.id}`, c.id, now - 45_000] },
        { sql: "INSERT INTO atomik_steps(id,chat_id,message_id,position,kind,title,prompt,model,status,est_cost_usd,refs,created_at,updated_at) VALUES(?,?,?,0,'video',?,?,?,'proposed',?,?,?,?)",
          args: [`st_${c.id}`, c.id, `ma_${c.id}`, `Step of ${c.id}`, `${c.secret} prompt`, MODEL, c.usd, JSON.stringify([{ uploadId: `${c.secret}-attach` }]), now - 45_000, now - 45_000] },
      ]),
    ], "write");
    /* The retired rule as a workspace stored it (the row stays; nothing reads it): members up to the cap a shot, an admin above it. */
    await setSetting("approvalRule", "cap", "u_admin");
    await setSetting("shotCapCredits", String(await capBetween()), "u_admin");
  });
}

const read = async (ws: TenantWorkspace, viewer: { id: string; role: string; owner?: boolean }) => {
  const { runInTenant } = await import("../../lib/tenant");
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  return runInTenant(ws, () => readApprovals(viewer, now));
};
/* An admin's sheet of another person's step had an opaque key: counted as "sheet", so one would show; a person's own is their chat's id. */
const threads = (reply: Awaited<ReturnType<typeof read>>) => reply.items.filter((i) => i.source === "thread").map((i) => (i.id.startsWith("thread-step:") ? "sheet" : i.id)).sort();

test.beforeAll(async () => {
  await seed(A, [
    { id: "ach_a", by: "u_a", usd: 0.5, secret: "SECRETA" },
    { id: "ach_b", by: "u_b", usd: 0.5, secret: "SECRETB" },
    { id: "ach_big", by: "u_b", usd: 40, secret: "SECRETBIG" },
    { id: "ach_adm2", by: "u_admin2", usd: 40, secret: "SECRETADM" },
    { id: "ach_owner", by: "u_owner", usd: 40, secret: "SECRETOWN" },
  ]);
  await seed(B, [{ id: "ach_other_ws", by: "u_a", usd: 0.5, secret: "SECRETWS" }]);
});

test("a member sees only their own chat steps: another member's is absent, and no total or title of it leaves", async () => {
  const a = await read(A, { id: "u_a", role: "member" });
  expect(threads(a)).toEqual(["thread:ach_a"]);
  expect(a.items.find((i) => i.id === "thread:ach_a")).toMatchObject({ title: "SECRETA chat", canApprove: true });
  const json = JSON.stringify(a);
  expect(json).not.toMatch(/SECRETB|SECRETBIG|SECRETADM|SECRETOWN|ach_b|ach_big/);
  /* The same for the other member, and a decision is only on their own chats too. */
  const b = await read(A, { id: "u_b", role: "member" });
  expect(threads(b)).toEqual(["thread:ach_b", "thread:ach_big"]);
  expect(JSON.stringify(b)).not.toMatch(/SECRETA\b|ach_a/);
  expect(a.items.length).toBe(1);
});

test("an admin sees no other member's step, the one over the stored per-shot cap included: no title, no price, no sheet", async () => {
  const { billCredits, marginKeyOf } = await import("../../lib/creditTerms");
  const admin = await read(A, { id: "u_admin", role: "admin" });
  /* ach_big is over the stored cap (it used to be shown to an admin, title and price): absent now, like every member's step. */
  expect(billCredits(40, marginKeyOf("video", MODEL))).toBeGreaterThan(await capBetween());
  expect(threads(admin)).toEqual([]);
  const json = JSON.stringify(admin);
  expect(json, "no chat words, prompt, attachment, title or step id").not.toMatch(/SECRET|Step of|st_ach|ach_big|thread-step:/);
  expect(admin.decided.length).toBe(0);
});

test("whatever rule and cap a workspace stored, an admin is shown none of a member's steps", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { setSetting } = await import("../../lib/settings");
  const { billCredits, marginKeyOf } = await import("../../lib/creditTerms");
  const cheap = billCredits(0.5, marginKeyOf("video", MODEL));
  /* A cap under every step: every step used to need an admin. */
  await runInTenant(A, async () => { await setSetting("approvalRule", "cap", "u_admin"); await setSetting("shotCapCredits", String(Math.max(1, cheap - 1)), "u_admin"); });
  const over = await read(A, { id: "u_admin", role: "admin" });
  expect(threads(over), "a stored cap under every step shows none of them").toEqual([]);
  expect(JSON.stringify(over)).not.toMatch(/SECRET/);
  /* No rule at all: the same. */
  await runInTenant(A, async () => { await setSetting("approvalRule", "anyone", "u_admin"); });
  expect(threads(await read(A, { id: "u_admin", role: "admin" }))).toEqual([]);
  /* Each member still sees their own, at its price, theirs to continue. */
  expect(threads(await read(A, { id: "u_b", role: "member" }))).toEqual(["thread:ach_b", "thread:ach_big"]);
  /* Back to the seeded rows for the specs after this one. */
  const seeded = await capBetween();
  await runInTenant(A, async () => { await setSetting("approvalRule", "cap", "u_admin"); await setSetting("shotCapCredits", String(seeded), "u_admin"); });
});

test("the workspace owner and each admin see their own chat in full and no one else's; an agent identity sees nothing extra; another workspace is its own", async () => {
  const owner = await read(A, { id: "u_owner", role: "admin", owner: true });
  expect(threads(owner)).toEqual(["thread:ach_owner"]);
  expect(owner.items.find((i) => i.id === "thread:ach_owner")?.title).toBe("SECRETOWN chat");
  expect(JSON.stringify(owner)).not.toMatch(/SECRETBIG|SECRETADM|SECRETA\b|SECRETB\b|Step of ach_big/);
  const admin2 = await read(A, { id: "u_admin2", role: "admin" });
  expect(threads(admin2)).toEqual(["thread:ach_adm2"]);
  /* Atomik's agent identity: no chat is its own, and it is never an admin. */
  const agent = await read(A, { id: "agent:run1", role: "admin", owner: true });
  expect(threads(agent)).toEqual([]);
  /* Another workspace holds its own, and a viewer sees nothing of this one there. */
  const b = await read(B, { id: "u_a", role: "member" });
  expect(threads(b)).toEqual(["thread:ach_other_ws"]);
  expect(JSON.stringify(b)).not.toMatch(/ach_a\b|ach_big|SECRETA\b/);
  expect(JSON.stringify(await read(B, { id: "u_admin", role: "admin" }))).not.toMatch(/SECRET/);
});
