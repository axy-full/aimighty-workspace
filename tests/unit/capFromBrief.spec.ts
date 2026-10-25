import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The Brief's Other sets the production's own cap through the money path (lib/caps.ts setCapFromBrief; owner, 25 Oct 2026,
 * answers 3 (b) and 4): any member sets it where no cap is in force or lowers the one that is; raising it above the cap in force
 * is an owner's or an admin's; a token or Atomik never sets it; the house, billed in dollars, is refused. Local temporary
 * databases only; no provider is called.
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

const MEMBER = { kind: "person", role: "member" } as const;
const ADMIN = { kind: "person", role: "admin" } as const;
const OWNER = { kind: "person", role: "owner" } as const;

/* One workspace per test, a project in it with the given own cap (and unlock), and the workspace's budget per production if any. */
async function inWorkspace(id: string, setUp: { cap?: number | null; unlocked?: boolean; budget?: string }, fn: () => Promise<void>) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(workspace(id), async () => {
    await ready();
    await db().execute({ sql: "INSERT INTO projects(id, name, created_at) VALUES ('p', 'Film', 0)", args: [] });
    await db().execute({ sql: "UPDATE projects SET cap_credits = ?, cap_unlocked = ?, cap_warned_at = 5 WHERE id = 'p'", args: [setUp.cap ?? null, setUp.unlocked ? 1 : 0] });
    if (setUp.budget !== undefined) await db().execute({ sql: "INSERT INTO settings(key, value, updated_at) VALUES ('productionBudgetCredits', ?, 0)", args: [setUp.budget] });
    await fn();
  });
}

const row = async () => {
  const { db } = await import("../../lib/db");
  const r = (await db().execute("SELECT cap_credits, cap_unlocked, cap_warned_at FROM projects WHERE id = 'p'")).rows[0];
  return { cap: r.cap_credits == null ? null : Number(r.cap_credits), unlocked: Number(r.cap_unlocked) === 1, warned: r.cap_warned_at != null };
};

test("any member sets the spend limit where no cap is in force; the figure lands as the production's own cap", async () => {
  const { setCapFromBrief } = await import("../../lib/caps");
  await inWorkspace("brief_cap_free", {}, async () => {
    expect(await setCapFromBrief("p", 300, MEMBER)).toEqual({ ok: true });
    expect(await row()).toEqual({ cap: 300, unlocked: false, warned: false });
  });
});

test("a member lowers the cap in force or keeps it; raising it above is an owner's or an admin's, and a refusal writes nothing", async () => {
  const { setCapFromBrief, CAP_FROM_BRIEF } = await import("../../lib/caps");
  await inWorkspace("brief_cap_own", { cap: 500, unlocked: true }, async () => {
    const refused = await setCapFromBrief("p", 501, MEMBER);
    expect(refused).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.ownerOrAdmin });
    expect(JSON.stringify(refused)).not.toMatch(/50[01]/);
    expect(await row(), "nothing written").toEqual({ cap: 500, unlocked: true, warned: true });
    /* The same cap again keeps its unlock; a lower one re-locks it. */
    expect(await setCapFromBrief("p", 500, MEMBER)).toEqual({ ok: true });
    expect((await row()).unlocked).toBe(true);
    expect(await setCapFromBrief("p", 200, MEMBER)).toEqual({ ok: true });
    expect(await row()).toEqual({ cap: 200, unlocked: false, warned: false });
    for (const by of [ADMIN, OWNER]) {
      const cap = by === ADMIN ? 900 : 1200;
      expect(await setCapFromBrief("p", cap, by), by.role).toEqual({ ok: true });
      expect((await row()).cap).toBe(cap);
    }
  });
});

test("where the production follows the workspace's budget, that budget is the cap in force", async () => {
  const { setCapFromBrief, CAP_FROM_BRIEF } = await import("../../lib/caps");
  await inWorkspace("brief_cap_budget", { budget: "400" }, async () => {
    expect(await setCapFromBrief("p", 401, MEMBER)).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.ownerOrAdmin });
    expect((await row()).cap).toBeNull();
    expect(await setCapFromBrief("p", 400, MEMBER)).toEqual({ ok: true });
    expect((await row()).cap).toBe(400);
  });
  /* A budget that is not a valid one is no cap at all, as the gate reads it (lib/budgetPause.ts cleanBudget). */
  await inWorkspace("brief_cap_bad_budget", { budget: "lots" }, async () => {
    expect(await setCapFromBrief("p", 10_000, MEMBER)).toEqual({ ok: true });
  });
});

test("a token or Atomik never sets the spend limit, whatever the figure", async () => {
  const { setCapFromBrief, CAP_FROM_BRIEF } = await import("../../lib/caps");
  await inWorkspace("brief_cap_people", {}, async () => {
    /* A person with no role, or one that is not a workspace role, is not a person this path knows. */
    for (const by of [{ kind: "token" }, { kind: "agent" }, null, undefined, { kind: "person" }, { kind: "person", role: "super" }] as never[]) {
      expect(await setCapFromBrief("p", 100, by), JSON.stringify(by)).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.personOnly });
    }
    expect((await row()).cap).toBeNull();
  });
});

test("a figure that is not a whole number of credits from 1 is refused, and an unknown project is not found", async () => {
  const { setCapFromBrief, CAP_FROM_BRIEF } = await import("../../lib/caps");
  await inWorkspace("brief_cap_figures", { cap: 50 }, async () => {
    for (const figure of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, "300" as unknown as number]) {
      expect(await setCapFromBrief("p", figure, ADMIN), String(figure)).toEqual({ ok: false, status: 400, error: CAP_FROM_BRIEF.wholeCredits });
    }
    expect((await row()).cap).toBe(50);
    expect(await setCapFromBrief("nope", 10, ADMIN)).toEqual({ ok: false, status: 404, error: CAP_FROM_BRIEF.noSuch });
  });
});

test("the house, never billed in credits, is refused: its caps are not set from the Brief", async () => {
  const { setCapFromBrief, CAP_FROM_BRIEF } = await import("../../lib/caps");
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  await inWorkspace(HOUSE_WORKSPACE_ID, {}, async () => {
    expect(await setCapFromBrief("p", 100, OWNER)).toEqual({ ok: false, status: 403, error: CAP_FROM_BRIEF.creditsOnly });
    expect((await row()).cap).toBeNull();
  });
});
