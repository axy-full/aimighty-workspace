import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A spend reservation reads the workspace's caps and rules as the database holds
 * them now, never through the settings memo (lib/settings.ts, 10 s). With several
 * server processes (WEB_CONCURRENCY), an admin's change on one process only
 * invalidates that process's memo; another process must still apply it to the
 * very next reservation. Here "the other process" is a direct write to the
 * settings table, which leaves this process's memo stale, as it would be.
 * Mocked engines, local temporary databases only.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-fresh-settings-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "legacy.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const MODEL = "higgsfield-cinema-studio-4.0";
const MEMBER = { id: "member", email: "member@example.invalid", name: "Member", role: "member", owner: false, disabled: false, createdAt: 0, lastSeen: null };
/** One take's estimate in the engine's dollars (a fixture figure): well over 1 credit. */
const USD = 2;

async function workspace(id: string) {
  const { platformDb, platformReady, getWorkspace, grantCredits } = await import("../../lib/platform");
  const { billingReady } = await import("../../lib/billingLedger");
  await platformReady(); await billingReady();
  await platformDb().execute({ sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,'owner',1,0,0,20,200)`,
    args: [id, id, id, `file:${path.join(dir, `${id}.db`)}`] });
  await grantCredits(id, 10_000, "fixture", "owner", "manual");
  return (await getWorkspace(id))!;
}
async function inTenant<T>(ws: Awaited<ReturnType<typeof workspace>>, fn: () => Promise<T>) {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, async () => { const { ready } = await import("../../lib/db"); await ready(); return fn(); }, { user: MEMBER } as never);
}
const take = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "video" as const, engine: "higgsfield", model: MODEL, status: "running" as const, engineCostUsd: USD, ...extra });
const reserve = async (event: ReturnType<typeof take>, options: Record<string, unknown> = {}) => {
  const { reserveGenerationSpend } = await import("../../lib/generationRequests");
  return reserveGenerationSpend(event, options).then(() => "admitted", (e) => `${(e as { status?: number }).status}`);
};
async function reserved(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: `SELECT id FROM meter_events WHERE id=?`, args: [id] })).rows.length > 0;
}
/** Another server process's admin write: straight to the table, so only that process's memo would have been dropped. */
async function elsewhere(values: Record<string, string>) {
  const { db } = await import("../../lib/db");
  for (const [key, value] of Object.entries(values))
    await db().execute({ sql: `INSERT INTO settings(key,value,updated_at) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, args: [key, value] });
}

test("a per-shot cap switched on by another process applies to the next reservation, not 10 s later", async () => {
  const ws = await workspace("fresh_shot");
  await inTenant(ws, async () => {
    const { getSetting } = await import("../../lib/settings");
    expect(await getSetting("approvalRule")).toBe("anyone"); // this process's memo, now warm
    await elsewhere({ approvalRule: "cap", shotCapCredits: "1" });
    expect(await getSetting("approvalRule")).toBe("anyone"); // still stale: the memo alone would admit the take
    expect(await reserve(take("shot_take", { shotId: "shot1" }), { shotCapExempt: false })).toBe("403");
    expect(await reserved("shot_take")).toBe(false);
    /* The reservation's read also refreshed this process's memo. */
    expect(await getSetting("approvalRule")).toBe("cap");
    /* Switched off again elsewhere: the next take on the shot is admitted at once. */
    await elsewhere({ approvalRule: "anyone" });
    expect(await reserve(take("shot_take_2", { shotId: "shot1" }), { shotCapExempt: false })).toBe("admitted");
  });
});

test("a production cap's rule changed by another process (warn to stop) applies to the next reservation", async () => {
  const ws = await workspace("fresh_rule");
  await inTenant(ws, async () => {
    const { db } = await import("../../lib/db");
    const { getSetting } = await import("../../lib/settings");
    await db().execute(`INSERT INTO projects(id,name,created_at,cap_credits) VALUES('capped','capped',0,1)`);
    await elsewhere({ atCap: "warn" });
    expect(await getSetting("atCap")).toBe("warn"); // the memo holds "warn": over the cap is only a warning
    await elsewhere({ atCap: "stop" });
    expect(await getSetting("atCap")).toBe("warn");
    expect(await reserve(take("rule_take", { projectId: "capped" }))).toBe("409");
    expect(await reserved("rule_take")).toBe(false);
  });
});
