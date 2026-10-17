import type { InStatement, InValue, Transaction } from "@libsql/client";
import { db, ready, now } from "./db";
import { currentTenant } from "./tenant";
import { newInterfaceFor } from "./newInterface.server";
import { isHouseWorkspace } from "./houseWorkspace";
import { invalidateSettings } from "./settings";
import { securityAuditStatement, type SecurityAuditInput } from "./securityAudit";
import { assertPerson } from "./security/people-only";
import {
  SPEND_SETTING_KEYS, SPEND_SETTING_STORE_KEYS, HOUSE_LIMIT_REFUSAL, spendSettingsFrom, spendSettingsSwitchOn, spendLimitPeriod,
  raisesLimit, storedLimit, limitValue, pauseValue, askValue, type SpendSettings, type SpendSettingsPatch, type WrittenPause,
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
 * - **Raising the limit is the workspace owner's alone** (owner, 17 Oct, update two, item 5): a higher number, or no
 *   limit where there was one. Any admin may set a first limit or lower one. The owner is the membership whose role is
 *   `owner` (TenantUser.owner, the same test as lib/auth.ts requireOwner).
 * - **Not in the house.** The house workspace is never billed in credits; its cap stays the platform owner's, in
 *   dollars (lib/allowance.ts), and this credit limit is refused there. Its pause and ask-before-every-take are stored
 *   like any workspace's.
 * - **A limit pause lifts when the month turns** (UTC): read as running from the first moment of the next month. A
 *   person's pause does not lift by itself.
 * - **Audited.** Each change and its audit line (lib/securityAudit.ts) commit in one write transaction, with the read
 *   the change was decided from; a value that does not change writes neither. A pause or resume writes only over the
 *   exact stored value it was decided from, so the SQL never judges the row and cannot disagree with the read.
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

type Raw = Record<string, string | undefined>;
type Exec = Pick<Transaction, "execute">;

/** The three rows exactly as stored; a key never written is absent. */
async function storedRaw(on: Exec): Promise<Raw> {
  const marks = SPEND_SETTING_STORE_KEYS.map(() => "?").join(",");
  const rs = await on.execute({ sql: `SELECT key, value FROM settings WHERE key IN (${marks})`, args: [...SPEND_SETTING_STORE_KEYS] });
  return Object.fromEntries(rs.rows.map((r) => [String(r.key), String(r.value)]));
}

async function stored(at: number): Promise<SpendSettings> {
  await ready();
  return spendSettingsFrom(await storedRaw(db()), at);
}

/* One write transaction on the workspace's database (the lib/caps.ts inWrite idiom): the read a change decides from
   and its writes and audit lines land together, or not at all (SQLite serialises writers). */
async function inWrite<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  await ready();
  const tx = await db().transaction("write");
  try { const value = await fn(tx); await tx.commit(); return value; }
  catch (error) { await tx.rollback().catch(() => {}); throw error; }
  finally { tx.close(); }
}

/** `creditLimitApplies` is false in the house, whose cap is in dollars and the platform owner's. */
export type SpendSettingsView = SpendSettings & { period: { start: number; end: number }; creditLimitApplies: boolean };

/** The workspace's spend settings at `at`, with the month its limit counts in. Any signed-in member's route may show them. */
export async function readSpendSettings(at = now()): Promise<SpendSettingsView> {
  const ws = await requireOn();
  return { ...(await stored(at)), period: spendLimitPeriod(at), creditLimitApplies: !isHouseWorkspace(ws) };
}

/**
 * The upsert of one key. It is a no-op when the stored value is already this one, or when `guard` (a condition on the
 * stored value) does not hold; the caller then writes no audit line.
 */
function write(key: string, value: string, by: string | null, at: number, guard?: { sql: string; args: InValue[] }): InStatement {
  return {
    sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at
          WHERE settings.value IS NOT excluded.value${guard ? ` AND ${guard.sql}` : ""}`,
    args: [key, value, by ?? "server", at, ...(guard?.args ?? [])],
  };
}
/**
 * A pause or a resume holds only over the exact value its decision was read from (absent reads as NULL, which a stored
 * row never is). The SQL therefore never judges the row itself, and can never disagree with lib/spendSettings.ts's
 * read of it: whatever that read calls paused, a resume clears; whatever it calls running, a pause covers.
 */
const asRead = (raw: string | undefined) => ({ sql: `settings.value IS ?`, args: [raw ?? null] });
/**
 * A resume holds over any stored value but blank (the only value that reads as running without a month's lift). It is
 * not bound to the value read: a row the binding cannot match exactly (a BLOB, or text holding a NUL) still reads as
 * paused, and binding it would leave a pause no person can clear. A resume writes blank, so at worst it also clears a
 * pause made after its read, which is what the person asked for.
 */
const NOT_BLANK = { sql: `settings.value <> ''`, args: [] as InValue[] };
/** For an admin who is not the owner: the stored limit is blank (a first limit) or above the new one (a lowering). */
const whenNotRaising = (to: number) => ({ sql: `(settings.value = '' OR (settings.value GLOB '[0-9]*' AND CAST(settings.value AS INTEGER) > ?))`, args: [to] });

const STALE_LIMIT = "The monthly limit changed before this was saved. Only the workspace owner can raise it; look again and choose a lower limit.";
/** The stored limit is a value no writer makes (it reads as no limit): only the owner may replace it. */
const ODD_LIMIT = "Only the workspace owner can change this limit.";

/* Written only after its upsert wrote (checked in code), so unconditionally: the line can never hang on `changes()`. */
function audit(workspaceId: string, actorId: string | null, action: SecurityAuditInput["action"], details: SecurityAuditInput["details"] = {}): InStatement {
  return securityAuditStatement({ workspaceId, actorId, action, targetType: "workspace", targetId: workspaceId, details }, false);
}

/**
 * Changes the settings a person asked to change, and only those that differ. Returns what changed. A pause made here
 * is always the person's (`admin`); a resume clears a pause whatever made it.
 */
export async function changeSpendSettings(patch: SpendSettingsPatch, at = now()): Promise<{ settings: SpendSettingsView; changed: string[] }> {
  return change(patch, at, null);
}

/**
 * TESTS ONLY: the same change, deciding from stored rows the test supplies (a stale read), to prove the writes' own
 * conditions hold when the read is out of date. Every check above still runs; a guard keeps every other source file
 * from naming it (tests/unit/spendSettings.spec.ts).
 */
export async function changeSpendSettingsFromReadForTests(patch: SpendSettingsPatch, raw: Record<string, string | undefined>, at = now()): Promise<{ settings: SpendSettingsView; changed: string[] }> {
  return change(patch, at, raw);
}

async function change(patch: SpendSettingsPatch, at: number, staleRaw: Raw | null): Promise<{ settings: SpendSettingsView; changed: string[] }> {
  const ws = await requireOn();
  const store = currentTenant();
  assertPerson({ user: store?.user, token: store?.token });
  const user = store!.user!;
  if (user.role !== "admin") throw new SpendSettingsError("Only an admin can change the spend limit and its settings.", 403);
  if (patch.monthlyLimitCredits !== undefined && isHouseWorkspace(ws)) throw new SpendSettingsError(HOUSE_LIMIT_REFUSAL, 409);
  const owner = user.owner === true;
  const changed = await inWrite(async (tx) => {
    const raw = staleRaw ?? await storedRaw(tx);
    const was = spendSettingsFrom(raw, at);
    const limitTo = patch.monthlyLimitCredits;
    if (limitTo !== undefined && !owner && raisesLimit(was.monthlyLimitCredits, limitTo))
      throw new SpendSettingsError("Only the workspace owner can raise the monthly limit or remove it.", 403);
    const done: string[] = [];
    /* Each change is its upsert, then its audit line only if the upsert wrote. */
    const step = async (name: string, upsert: InStatement, line: InStatement): Promise<boolean> => {
      const wrote = ((await tx.execute(upsert)).rowsAffected ?? 0) > 0;
      if (wrote) { await tx.execute(line); done.push(name); }
      return wrote;
    };
    if (limitTo !== undefined && limitTo !== was.monthlyLimitCredits) {
      const wrote = await step("monthlyLimitCredits",
        /* A non-owner's write holds only if it still lowers (or is a first limit) against the row as it stands. */
        write(SPEND_SETTING_KEYS.limit, limitValue(limitTo), user.id, at, owner || limitTo === null ? undefined : whenNotRaising(limitTo)),
        audit(ws.id, user.id, "spend_limit.set", { limitCredits: limitTo }));
      /* Refused against the row as it stands (it moved since the read, or holds a value no writer makes): say so, and
         nothing in this change is written. The same value already there is not a refusal. */
      if (!wrote && !owner) {
        const standing = (await storedRaw(tx))[SPEND_SETTING_KEYS.limit];
        if (standing !== limitValue(limitTo)) throw new SpendSettingsError(standing && storedLimit(standing) === null ? ODD_LIMIT : STALE_LIMIT, 409);
      }
    }
    const rawPause = raw[SPEND_SETTING_KEYS.pause];
    if (patch.paused === true && !was.pause)
      await step("paused", write(SPEND_SETTING_KEYS.pause, pauseValue({ at, by: user.id, reason: "admin" }), user.id, at, asRead(rawPause)),
        audit(ws.id, user.id, "spend.paused", { reason: "admin" }));
    else if (patch.paused === false && was.pause)
      await step("paused", write(SPEND_SETTING_KEYS.pause, pauseValue(null), user.id, at, NOT_BLANK), audit(ws.id, user.id, "spend.resumed"));
    if (patch.askBeforeEveryTake !== undefined && patch.askBeforeEveryTake !== was.askBeforeEveryTake)
      await step("askBeforeEveryTake", write(SPEND_SETTING_KEYS.ask, askValue(patch.askBeforeEveryTake), user.id, at),
        audit(ws.id, user.id, patch.askBeforeEveryTake ? "spend.ask_every_take_on" : "spend.ask_every_take_off"));
    return done;
  });
  if (changed.length) invalidateSettings();
  return { settings: await readSpendSettings(at), changed };
}

/**
 * The server's own pause, on reaching the limit (reason `limit`, no person). NOTHING CALLS THIS YET: the wiring that
 * decides the limit is reached is a later money PR. Returns false when the workspace was already paused.
 */
export async function recordLimitPause(at = now()): Promise<boolean> {
  const ws = await requireOn();
  const pause: WrittenPause = { at, by: null, reason: "limit" };
  const wrote = await inWrite(async (tx) => {
    const raw = await storedRaw(tx);
    if (spendSettingsFrom(raw, at).pause) return false;
    if (((await tx.execute(write(SPEND_SETTING_KEYS.pause, pauseValue(pause), null, at, asRead(raw[SPEND_SETTING_KEYS.pause])))).rowsAffected ?? 0) === 0) return false;
    await tx.execute(audit(ws.id, null, "spend.paused", { reason: "limit" }));
    return true;
  });
  if (wrote) invalidateSettings();
  return wrote;
}
