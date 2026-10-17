import type { InStatement } from "@libsql/client";
import { db, ready, now } from "./db";
import { currentTenant } from "./tenant";
import { newInterfaceFor } from "./newInterface.server";
import { invalidateSettings } from "./settings";
import { securityAuditStatement, type SecurityAuditInput } from "./securityAudit";
import { assertPerson } from "./security/people-only";
import {
  SPEND_SETTING_KEYS, SPEND_SETTING_STORE_KEYS, spendSettingsFrom, spendSettingsSwitchOn, spendLimitPeriod,
  limitValue, pauseValue, askValue, type SpendSettings, type SpendSettingsPatch, type WrittenPause,
} from "./spendSettings";

/**
 * The store for a workspace's own spend settings (lib/spendSettings.ts; v30 A4). STORED ONLY: nothing that quotes,
 * admits, reserves, meters or asks reads them yet, and only app/api/settings/spend/route.ts imports this file.
 *
 * - **Behind `V30_SPEND_LIMIT`, off.** Every entry refuses with a 404 before it touches the database unless the switch
 *   is exactly "1" and the workspace has the new interface (lib/newInterface.server.ts).
 * - **The workspace in scope, only.** The rows are in the workspace's own database (`db()`, which throws with no
 *   workspace in scope); nothing here takes a workspace id from a caller.
 * - **Changed by an admin who is a person.** The caller is the request's own (the tenant store), never an argument: a
 *   member is refused (403), and so are an API or MCP token and an `agent:` identity, admin or not (rules 11 and 14).
 * - **Audited.** Each change and its audit line (lib/securityAudit.ts) commit in one batch; a value that does not
 *   change writes neither.
 */

export class SpendSettingsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SpendSettingsError";
  }
}

/** Whether the switch is on for this workspace. */
export async function spendSettingsOn(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!spendSettingsSwitchOn() || !workspace) return false;
  return newInterfaceFor(workspace);
}

async function requireOn(): Promise<{ id: string }> {
  const ws = currentTenant()?.workspace;
  if (!ws || !(await spendSettingsOn(ws))) throw new SpendSettingsError("Not found.", 404);
  return ws;
}

async function stored(): Promise<SpendSettings> {
  await ready();
  const marks = SPEND_SETTING_STORE_KEYS.map(() => "?").join(",");
  const rs = await db().execute({ sql: `SELECT key, value FROM settings WHERE key IN (${marks})`, args: [...SPEND_SETTING_STORE_KEYS] });
  return spendSettingsFrom(Object.fromEntries(rs.rows.map((r) => [String(r.key), String(r.value)])));
}

export type SpendSettingsView = SpendSettings & { period: { start: number; end: number } };

/** The workspace's spend settings, with the month its limit counts in. Any signed-in member's route may show them. */
export async function readSpendSettings(at = now()): Promise<SpendSettingsView> {
  await requireOn();
  return { ...(await stored()), period: spendLimitPeriod(at) };
}

/**
 * The upsert of one key. It is a no-op when the stored value is already this one, or when `when` (a condition on the
 * stored value) does not hold, so `changes()` is 0 and the audit line after it is skipped: two pauses at once write
 * one pause and one line.
 */
function write(key: string, value: string, by: string | null, at: number, when: "always" | "running" | "paused" = "always"): InStatement {
  const guard = when === "running" ? ` AND settings.value = ''` : when === "paused" ? ` AND settings.value <> ''` : "";
  return {
    sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at
          WHERE settings.value IS NOT excluded.value${guard}`,
    args: [key, value, by ?? "server", at],
  };
}

function audit(workspaceId: string, actorId: string | null, action: SecurityAuditInput["action"], details: SecurityAuditInput["details"] = {}): InStatement {
  return securityAuditStatement({ workspaceId, actorId, action, targetType: "workspace", targetId: workspaceId, details }, true);
}

/**
 * Changes the settings a person asked to change, and only those that differ. Returns what changed. A pause made here
 * is always the person's (`admin`); a resume clears a pause whatever made it.
 */
export async function changeSpendSettings(patch: SpendSettingsPatch, at = now()): Promise<{ settings: SpendSettingsView; changed: string[] }> {
  return change(patch, at, stored);
}

/**
 * TESTS ONLY: the same change, deciding from a read the test supplies (a stale one), to prove the upserts' own
 * conditions hold when the read is out of date. Every check above still runs; a guard keeps every other source file
 * from naming it (tests/unit/spendSettings.spec.ts).
 */
export async function changeSpendSettingsFromReadForTests(patch: SpendSettingsPatch, was: SpendSettings, at = now()): Promise<{ settings: SpendSettingsView; changed: string[] }> {
  return change(patch, at, async () => was);
}

async function change(patch: SpendSettingsPatch, at: number, read: () => Promise<SpendSettings>): Promise<{ settings: SpendSettingsView; changed: string[] }> {
  const ws = await requireOn();
  const store = currentTenant();
  assertPerson({ user: store?.user, token: store?.token });
  const user = store!.user!;
  if (user.role !== "admin") throw new SpendSettingsError("Only an admin can change the spend limit and its settings.", 403);
  const was = await read();
  /* Each change is its upsert then its audit line; what changed is read back from the upserts' own counts. */
  const steps: { name: string; upsert: InStatement; line: InStatement }[] = [];
  if (patch.monthlyLimitCredits !== undefined && patch.monthlyLimitCredits !== was.monthlyLimitCredits)
    steps.push({ name: "monthlyLimitCredits", upsert: write(SPEND_SETTING_KEYS.limit, limitValue(patch.monthlyLimitCredits), user.id, at),
      line: audit(ws.id, user.id, "spend_limit.set", { limitCredits: patch.monthlyLimitCredits }) });
  if (patch.paused === true && !was.pause)
    steps.push({ name: "paused", upsert: write(SPEND_SETTING_KEYS.pause, pauseValue({ at, by: user.id, reason: "admin" }), user.id, at, "running"),
      line: audit(ws.id, user.id, "spend.paused", { reason: "admin" }) });
  else if (patch.paused === false && was.pause)
    steps.push({ name: "paused", upsert: write(SPEND_SETTING_KEYS.pause, pauseValue(null), user.id, at, "paused"), line: audit(ws.id, user.id, "spend.resumed") });
  if (patch.askBeforeEveryTake !== undefined && patch.askBeforeEveryTake !== was.askBeforeEveryTake)
    steps.push({ name: "askBeforeEveryTake", upsert: write(SPEND_SETTING_KEYS.ask, askValue(patch.askBeforeEveryTake), user.id, at),
      line: audit(ws.id, user.id, patch.askBeforeEveryTake ? "spend.ask_every_take_on" : "spend.ask_every_take_off") });
  let changed: string[] = [];
  if (steps.length) {
    const results = await db().batch(steps.flatMap((step) => [step.upsert, step.line]), "write");
    changed = steps.filter((_, i) => (results[i * 2]?.rowsAffected ?? 0) > 0).map((step) => step.name);
    invalidateSettings();
  }
  return { settings: await readSpendSettings(at), changed };
}

/**
 * The server's own pause, on reaching the limit (reason `limit`, no person). NOTHING CALLS THIS YET: the wiring that
 * decides the limit is reached is a later money PR. Returns false when the workspace was already paused.
 */
export async function recordLimitPause(at = now()): Promise<boolean> {
  const ws = await requireOn();
  if ((await stored()).pause) return false;
  const pause: WrittenPause = { at, by: null, reason: "limit" };
  const [done] = await db().batch([write(SPEND_SETTING_KEYS.pause, pauseValue(pause), null, at, "running"), audit(ws.id, null, "spend.paused", { reason: "limit" })], "write");
  invalidateSettings();
  return (done?.rowsAffected ?? 0) > 0;
}
