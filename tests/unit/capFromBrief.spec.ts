import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantStore, TenantUser, TenantWorkspace } from "../../lib/tenant";

/**
 * The Brief's Other sets the production's own cap through the money path (lib/caps.ts setCapFromBrief; owner, 25 Oct 2026,
 * answers 3 (b) and 4): any member sets it where no cap is in force or lowers the one that is; raising it above the cap in force
 * is an owner's or an admin's; a token or Atomik never sets it, and who is setting it is read from the request's own store,
 * never claimed by the caller; the house, billed in dollars, is refused. Local temporary databases only; no provider is called.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-cap-from-brief-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const workspace = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, legacy: false, usesPlatformKeys: true, keys: {}, ownerId: "tester", createdAt: 0,
  allowanceUsd: null, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});

const person = (id: string, role: TenantUser["role"], owner = false, disabled = false): TenantUser =>
  ({ id, email: `${id}@example.invalid`, name: id, role, owner, disabled, createdAt: 0, lastSeen: null });
/* lib/auth.ts maps a workspace owner to role "admin" with owner set. */
const MEMBER: Partial<TenantStore> = { user: person("u_member", "member") };
const ADMIN: Partial<TenantStore> = { user: person("u_admin", "admin") };
const OWNER: Partial<TenantStore> = { user: person("u_owner", "admin", true) };

/* One workspace per test, a project in it with the given own cap (and unlock), and the workspace's budget per production if any.
   `as(who, credits)` asks as that request would: its user and token are in the store, as the route wrapper puts them. */
async function inWorkspace(
  id: string, setUp: { cap?: number | null; unlocked?: boolean; budget?: string },
  fn: (as: (who: Partial<TenantStore>, credits: number, project?: string) => Promise<unknown>) => Promise<void>,
) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { setCapFromBrief } = await import("../../lib/caps");
  await runInTenant(workspace(id), async () => {
    await ready();
    await db().execute({ sql: "INSERT INTO projects(id, name, created_at) VALUES ('p', 'Film', 0)", args: [] });
    await db().execute({ sql: "UPDATE projects SET cap_credits = ?, cap_unlocked = ?, cap_warned_at = 5 WHERE id = 'p'", args: [setUp.cap ?? null, setUp.unlocked ? 1 : 0] });
    if (setUp.budget !== undefined) await db().execute({ sql: "INSERT INTO settings(key, value, updated_at) VALUES ('productionBudgetCredits', ?, 0)", args: [setUp.budget] });
  });
  await runInTenant(workspace(id), () => fn((who, credits, project = "p") => runInTenant(workspace(id), () => setCapFromBrief(project, credits), who)));
}

const row = async () => {
  const { db } = await import("../../lib/db");
  const r = (await db().execute("SELECT cap_credits, cap_unlocked, cap_warned_at FROM projects WHERE id = 'p'")).rows[0];
  return { cap: r.cap_credits == null ? null : Number(r.cap_credits), unlocked: Number(r.cap_unlocked) === 1, warned: r.cap_warned_at != null };
};

test("any member sets the spend limit where no cap is in force; the figure lands as the production's own cap", async () => {
  await inWorkspace("brief_cap_free", {}, async (as) => {
    expect(await as(MEMBER, 300)).toEqual({ ok: true });
    expect(await row()).toEqual({ cap: 300, unlocked: false, warned: false });
  });
});

test("a member lowers the cap in force or keeps it; raising it above is an owner's or an admin's, and a refusal writes nothing", async () => {
  const { CAP_FROM_BRIEF } = await import("../../lib/caps");
  await inWorkspace("brief_cap_own", { cap: 500, unlocked: true }, async (as) => {
    const refused = await as(MEMBER, 501);
    expect(refused).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.ownerOrAdmin });
    expect(JSON.stringify(refused)).not.toMatch(/50[01]/);
    expect(await row(), "nothing written").toEqual({ cap: 500, unlocked: true, warned: true });
    /* The same cap again keeps its unlock; a lower one re-locks it. */
    expect(await as(MEMBER, 500)).toEqual({ ok: true });
    expect((await row()).unlocked).toBe(true);
    expect(await as(MEMBER, 200)).toEqual({ ok: true });
    expect(await row()).toEqual({ cap: 200, unlocked: false, warned: false });
    for (const [who, cap] of [[ADMIN, 900], [OWNER, 1200]] as const) {
      expect(await as(who, cap), String(cap)).toEqual({ ok: true });
      expect((await row()).cap).toBe(cap);
    }
  });
});

test("where the production follows the workspace's budget, that budget is the cap in force", async () => {
  const { CAP_FROM_BRIEF } = await import("../../lib/caps");
  await inWorkspace("brief_cap_budget", { budget: "400" }, async (as) => {
    expect(await as(MEMBER, 401)).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.ownerOrAdmin });
    expect((await row()).cap).toBeNull();
    expect(await as(MEMBER, 400)).toEqual({ ok: true });
    expect((await row()).cap).toBe(400);
  });
  /* A budget that is not a valid one is no cap at all, as the gate reads it (lib/budgetPause.ts cleanBudget). */
  await inWorkspace("brief_cap_bad_budget", { budget: "lots" }, async (as) => {
    expect(await as(MEMBER, 10_000)).toEqual({ ok: true });
  });
});

test("a token or Atomik never sets the spend limit, whatever role the request's user holds; nor does a disabled person or no one", async () => {
  const { CAP_FROM_BRIEF } = await import("../../lib/caps");
  const token = { id: "tok", name: "t", scope: "render", capUsd: null } as const;
  await inWorkspace("brief_cap_people", { cap: 100 }, async (as) => {
    const refusedFor: Partial<TenantStore>[] = [
      /* An admin's own token (a token request carries its maker as the user), for a raise and for a cut alike. */
      { user: person("u_admin", "admin"), token }, { user: person("u_owner", "admin", true), token: { ...token, scope: "prepare" } },
      { user: person("agent:run_1", "admin") }, { user: person("server", "admin", true) },
      { user: person("u_gone", "admin", false, true) }, { user: null }, {},
    ];
    for (const who of refusedFor) for (const credits of [5_000, 50]) {
      expect(await as(who, credits), JSON.stringify({ who, credits })).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.personOnly });
    }
    expect((await row()).cap).toBe(100);
  });
});

test("a figure that is not a whole number of credits from 1 is refused, and an unknown project is not found", async () => {
  const { CAP_FROM_BRIEF } = await import("../../lib/caps");
  await inWorkspace("brief_cap_figures", { cap: 50 }, async (as) => {
    for (const figure of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "300" as unknown as number]) {
      expect(await as(ADMIN, figure), String(figure)).toEqual({ ok: false, status: 400, error: CAP_FROM_BRIEF.wholeCredits });
    }
    expect((await row()).cap).toBe(50);
    expect(await as(ADMIN, 10, "nope")).toEqual({ ok: false, status: 404, error: CAP_FROM_BRIEF.noSuch });
  });
});

test("the house, never billed in credits, is refused: its caps are not set from the Brief", async () => {
  const { CAP_FROM_BRIEF } = await import("../../lib/caps");
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  await inWorkspace(HOUSE_WORKSPACE_ID, {}, async (as) => {
    expect(await as(OWNER, 100)).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.creditsOnly });
    expect((await row()).cap).toBeNull();
  });
});
