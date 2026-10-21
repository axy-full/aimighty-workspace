import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Atomik chat steps are their own person's (owner, 12 Oct): a member is shown their own steps and nothing of anyone else's (not even a count); an admin is shown
 * another MEMBER's step only while it needs an admin's tap (over the workspace's per-shot cap; guardrail 4's per-job line was retired on 20 Oct 2026, so a step's
 * size alone never needs an admin), and then only its title and its price; as soon as
 * it needs no admin it is gone. Another admin's step, and every decision on a chat that is not theirs, are absent. Atomik's agent identities see nothing extra.
 * Real temporary databases; sign-in is a fake; nothing is sent or spent.
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
/* The workspace's own per-shot cap, between a cheap step (US$0.5 of engine) and a big one (US$40): only the big one needs an admin. Synthetic dollars, made up for this test. */
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
    /* The workspace's own rule: members up to the cap a shot, an admin above it. */
    await setSetting("approvalRule", "cap", "u_admin");
    await setSetting("shotCapCredits", String(await capBetween()), "u_admin");
  });
}

const read = async (ws: TenantWorkspace, viewer: { id: string; role: string; owner?: boolean }) => {
  const { runInTenant } = await import("../../lib/tenant");
  const { readApprovals } = await import("../../lib/control-room/approvals.server");
  return runInTenant(ws, () => readApprovals(viewer, now));
};
/* An admin's sheet of another person's step has an opaque key, so it is counted as "sheet"; a person's own is their chat's id. */
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
  expect(a.items.find((i) => i.id === "thread:ach_a")).toMatchObject({ title: "SECRETA chat", needsAdmin: false });
  const json = JSON.stringify(a);
  expect(json).not.toMatch(/SECRETB|SECRETBIG|SECRETADM|SECRETOWN|ach_b|ach_big/);
  /* The same for the other member, and a decision is only on their own chats too. */
  const b = await read(A, { id: "u_b", role: "member" });
  expect(threads(b)).toEqual(["thread:ach_b", "thread:ach_big"]);
  expect(JSON.stringify(b)).not.toMatch(/SECRETA\b|ach_a/);
  expect(a.items.length).toBe(1);
});

test("an admin sees another member's step only while it needs an admin: over the workspace's per-shot cap, only its title and price; a step under the cap is absent", async () => {
  const { billCredits, marginKeyOf } = await import("../../lib/creditTerms");
  const admin = await read(A, { id: "u_admin", role: "admin" });
  /* ach_a and ach_b are under the workspace's cap: absent. ach_big (a member's) is over it: shown. Another admin's and the owner's are absent. */
  expect(threads(admin)).toEqual(["sheet"]);
  const credits = billCredits(40, marginKeyOf("video", MODEL));
  expect(credits).toBeGreaterThan(await capBetween());
  const item = admin.items.find((i) => i.source === "thread")!;
  expect(item.id).toMatch(/^thread-step:[0-9a-f]{16}$/);
  expect(item).toMatchObject({ title: "Step of ach_big", price: { kind: "up-to", credits }, needsAdmin: true, note: null, step: null, where: "Atomik", canApprove: true, decline: null, open: { kind: "none" } });
  /* An admin may approve it (owner, 13 Oct): the step's id is what the claim needs; there is no chat id and nothing to open. */
  expect(item.approve).toEqual({ kind: "thread", chatId: null, stepId: "st_ach_big", productionId: null });
  const json = JSON.stringify(admin);
  expect(json, "no chat words, prompt or attachment").not.toMatch(/SECRET/);
  expect(json).not.toMatch(/A plan|first_ask|attach|uploadId|"prompt"/);
  expect(json).not.toMatch(/"chatId":"|thread:ach_|"id":"st_ach/);
  expect(admin.decided.length).toBe(0);
});

test("the per-shot cap rule counts too, and the step goes as soon as it needs no admin", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { setSetting } = await import("../../lib/settings");
  const { billCredits, marginKeyOf } = await import("../../lib/creditTerms");
  const cheap = billCredits(0.5, marginKeyOf("video", MODEL));
  await runInTenant(A, async () => { await setSetting("approvalRule", "cap", "u_admin"); await setSetting("shotCapCredits", String(Math.max(1, cheap - 1)), "u_admin"); });
  const over = await read(A, { id: "u_admin", role: "admin" });
  expect(threads(over), "over the cap, the cheap steps need an admin too").toEqual(["sheet", "sheet", "sheet"]);
  expect(JSON.stringify(over)).not.toMatch(/SECRET/);
  /* No per-job line (owner, 20 Oct 2026): with the cap above every step, none needs an admin, the big one (over the old 200 cr line) included. */
  const big = billCredits(40, marginKeyOf("video", MODEL));
  expect(big).toBeGreaterThan(200);
  await runInTenant(A, async () => { await setSetting("shotCapCredits", String(big + 1000), "u_admin"); });
  const under = await read(A, { id: "u_admin", role: "admin" });
  expect(threads(under), "under the cap, no step needs an admin, whatever its size").toEqual([]);
  /* With no rule at all ("anyone"), the same: a step's size alone never needs an admin. */
  await runInTenant(A, async () => { await setSetting("approvalRule", "anyone", "u_admin"); });
  expect(threads(await read(A, { id: "u_admin", role: "admin" })), "no rule: no step needs an admin").toEqual([]);
  /* Back to the seeded rule for the specs after this one. */
  const seeded = await capBetween();
  await runInTenant(A, async () => { await setSetting("approvalRule", "cap", "u_admin"); await setSetting("shotCapCredits", String(seeded), "u_admin"); });
});

test("the workspace owner is an admin here; an admin's own chat shows in full to them, another admin's does not; an agent identity sees nothing extra; another workspace is its own", async () => {
  const owner = await read(A, { id: "u_owner", role: "admin", owner: true });
  expect(threads(owner).sort()).toEqual(["sheet", "thread:ach_owner"]);
  expect(owner.items.find((i) => i.id === "thread:ach_owner")?.title).toBe("SECRETOWN chat");
  expect(owner.items.find((i) => i.id.startsWith("thread-step:"))?.title).toBe("Step of ach_big");
  expect(JSON.stringify(owner)).not.toMatch(/SECRETBIG|SECRETADM|SECRETA\b|SECRETB\b/);
  const admin2 = await read(A, { id: "u_admin2", role: "admin" });
  expect(threads(admin2).sort()).toEqual(["sheet", "thread:ach_adm2"]);
  /* Atomik's agent identity: no chat is its own, and it is never an admin. */
  const agent = await read(A, { id: "agent:run1", role: "admin", owner: true });
  expect(threads(agent)).toEqual([]);
  /* Another workspace holds its own, and a viewer sees nothing of this one there. */
  const b = await read(B, { id: "u_a", role: "member" });
  expect(threads(b)).toEqual(["thread:ach_other_ws"]);
  expect(JSON.stringify(b)).not.toMatch(/ach_a\b|ach_big|SECRETA\b/);
  expect(JSON.stringify(await read(B, { id: "u_admin", role: "admin" }))).not.toMatch(/SECRET/);
});
