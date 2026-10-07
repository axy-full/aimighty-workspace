import { db, ready, now } from "./db";
import { currentTenant } from "./tenant";
import { creditsApply } from "./credits";
import { billCreditsWith, marginFor, marginKeyOf } from "./creditTerms";
import { creditsFor, type EstimateTerms } from "./billingTerms";
import { getSetting, invalidateSettings } from "./settings";
import { workspaceAdmins, platformDb, platformReady } from "./platform";
import { notify } from "./push";
import { budgetPause, budgetPauseLine, cleanBudget, cleanWarnPct, type BudgetPause } from "./budgetPause";

export { budgetPause, budgetPauseLine, cleanBudget, cleanWarnPct, type BudgetPause };

/**
 * A production's cap, in the workspace's unit.
 *
 * A workspace that pays in credits caps a production in credits and is
 * measured against what the meter billed it; one that pays its vendors in
 * dollars caps in dollars and is measured against what they charged. The
 * rules are the workspace's: warn the producer at a share of the cap, and
 * at the cap either stop, let a producer unlock, or only warn. The
 * workspace balance is the hard stop above all of this (lib/held.ts).
 */
export type CapRule = "producer" | "stop" | "warn";
export type CapUnit = "cr" | "$";
export type CapVerdict = { allow: boolean; error?: string; notice?: string; pct: number | null; warned: boolean };

const fmt = (n: number, unit: CapUnit) => (unit === "cr" ? `${Math.round(n).toLocaleString("en-US")} cr` : `$${n.toFixed(2)}`);

/** The rule at the cap, with nothing read from anywhere. */
export function capVerdict(o: { cap: number | null; spent: number; needs: number; rule: CapRule; unlocked: boolean; warnPct: number; unit: CapUnit }): CapVerdict {
  if (o.cap == null || !(o.cap > 0)) return { allow: true, pct: null, warned: false };
  const after = o.spent + o.needs;
  const pct = Math.round((after / o.cap) * 100);
  const over = after > o.cap + 1e-9;
  if (over && !o.unlocked) {
    if (o.rule === "stop") {
      return { allow: false, pct, warned: false, error: `Over this production's cap: ${fmt(o.cap, o.unit)} cap, ${fmt(o.spent, o.unit)} spent, this needs ${fmt(o.needs, o.unit)}. An admin can raise the cap.` };
    }
    if (o.rule === "producer") {
      return { allow: false, pct, warned: false, error: `At this production's cap of ${fmt(o.cap, o.unit)} (${fmt(o.spent, o.unit)} spent, this needs ${fmt(o.needs, o.unit)}). An admin can unlock it or raise it.` };
    }
    return { allow: true, pct, warned: true, notice: `Over this production's cap of ${fmt(o.cap, o.unit)} by ${fmt(after - o.cap, o.unit)}.` };
  }
  if (over && o.unlocked) return { allow: true, pct, warned: false, notice: `Past this production's cap of ${fmt(o.cap, o.unit)}, unlocked by an admin.` };
  if (pct >= o.warnPct) return { allow: true, pct, warned: true, notice: `${pct}% of this production's cap of ${fmt(o.cap, o.unit)}.` };
  return { allow: true, pct, warned: false };
}

/** The workspace's budget per production now, in credits, or null when none is set. */
export async function workspaceBudget(): Promise<number | null> {
  return cleanBudget(await getSetting("productionBudgetCredits"));
}

/** A production's cap as set, with nothing spent read. `from` says whose it is: the production's own, or the workspace's budget. */
export type CapRow = { unit: CapUnit; cap: number | null; unlocked: boolean; warnedAt: number | null; name: string; from?: "production" | "workspace" | null };
/** The cap and what the production has spent against it, in the same unit. */
export type ProjectCap = CapRow & { spent: number };
export type Spent = { usd: number; credits: number };

const CHUNK = 400;
const chunks = <T,>(list: T[]): T[][] => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));
const marks = (list: unknown[]) => list.map(() => "?").join(",");

/**
 * What productions or shots have spent, reckoned the way the reservation gate
 * reckons it (reserveGenerationSpend in lib/generationRequests.ts), so the cap
 * on a screen, the warning at 80%, the pre-checks and the gate are one figure.
 *
 * Every take ever made counts, hidden ones included: deleting a take hides it
 * and gives nothing back. Takes merge by id with the meter's rows, which also
 * carry the text, training and compute jobs filed there. Where both hold a
 * figure the larger wins, and the meter's production or shot wins over the
 * take's. The pre-checks used to leave deleted takes out, so a take passed the
 * pre-check and was then refused by the gate with a different sentence.
 */
export async function spentBy(column: "project_id" | "shot_id", keys: string[]): Promise<Map<string, Spent>> {
  const out = new Map<string, Spent>(keys.map((k) => [k, { usd: 0, credits: 0 }]));
  if (!keys.length) return out;
  await ready();
  const rows = new Map<string, { key: string | null; usd: number; credits: number }>();
  const takes = async (where: string, args: string[]) => {
    for (const part of chunks(args)) {
      const rs = await db().execute({
        sql: `SELECT id, ${column} AS k, kind, model, COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0) AS cost FROM generations WHERE ${where} IN (${marks(part)})`,
        args: part,
      });
      for (const r of rs.rows as unknown as { id: string; k: string | null; kind: string | null; model: string | null; cost: number }[]) {
        const cost = Number(r.cost ?? 0);
        rows.set(String(r.id), { key: r.k == null ? null : String(r.k), usd: cost, credits: billCreditsWith(cost, marginFor(marginKeyOf(String(r.kind), String(r.model))), 0.10) });
      }
    }
  };
  await takes(column, keys);
  const workspaceId = currentTenant()?.workspace?.id;
  if (workspaceId) {
    try {
      await platformReady();
      const metered = new Map<string, { key: string | null; usd: number; credits: number }>();
      const read = async (where: string, args: string[]) => {
        for (const part of chunks(args)) {
          const rs = await platformDb().execute({
            sql: `SELECT id, ${column} AS k, engine_cost_usd, billed_credits FROM meter_events WHERE workspace_id = ? AND ${where} IN (${marks(part)})`,
            args: [workspaceId, ...part],
          });
          for (const r of rs.rows as unknown as { id: string; k: string | null; engine_cost_usd: number | null; billed_credits: number | null }[])
            metered.set(String(r.id), { key: r.k == null ? null : String(r.k), usd: Number(r.engine_cost_usd ?? 0), credits: Number(r.billed_credits ?? 0) });
        }
      };
      await read(column, keys);
      await read("id", [...rows.keys()].filter((id) => !metered.has(id)));
      /* A take filed elsewhere that the meter files here: its own cost too, as the gate reads it. */
      await takes("id", [...metered.keys()].filter((id) => !rows.has(id)));
      for (const [id, m] of metered) {
        const prior = rows.get(id);
        rows.set(id, { key: m.key ?? prior?.key ?? null, usd: Math.max(prior?.usd ?? 0, m.usd), credits: m.credits });
      }
    } catch { /* without the platform record, the takes alone */ }
  }
  for (const r of rows.values()) {
    const total = r.key == null ? undefined : out.get(r.key);
    if (total) { total.usd += r.usd; total.credits += r.credits; }
  }
  return out;
}

/**
 * The production's cap, in the workspace's unit: one read of its row, and
 * nothing spent. The reservation gate reads this and reckons the spend itself
 * inside its lock, so reading it here as well would be thrown away on every
 * reservation. Screens, warnings and pre-checks want projectCapSpent.
 */
export async function projectCap(projectId: string): Promise<CapRow | null> {
  await ready();
  const inCredits = creditsApply(currentTenant()?.workspace);
  const rs = await db().execute({
    sql: `SELECT p.name, p.cap_usd, p.cap_credits, p.cap_unlocked, p.cap_warned_at FROM projects p WHERE p.id = ?`,
    args: [projectId],
  });
  const r = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!r) return null;
  const own = inCredits ? (r.cap_credits == null ? null : Number(r.cap_credits)) : (r.cap_usd == null ? null : Number(r.cap_usd));
  /* A credits production with no cap of its own follows the workspace's budget per production, when an admin set one. */
  const budget = own == null && inCredits ? await workspaceBudget() : null;
  return {
    unit: inCredits ? "cr" : "$",
    cap: own ?? budget,
    unlocked: Number(r.cap_unlocked ?? 0) === 1,
    warnedAt: r.cap_warned_at == null ? null : Number(r.cap_warned_at),
    name: String(r.name ?? ""),
    from: own != null ? "production" : budget != null ? "workspace" : null,
  };
}

async function withSpent(projectId: string, row: CapRow): Promise<ProjectCap> {
  const spent = (await spentBy("project_id", [projectId])).get(projectId)!;
  return { ...row, spent: row.unit === "cr" ? spent.credits : spent.usd };
}

/** The production's cap and what it has spent, in the workspace's unit: the figure the gate enforces. */
export async function projectCapSpent(projectId: string): Promise<ProjectCap | null> {
  const row = await projectCap(projectId);
  return row ? withSpent(projectId, row) : null;
}

/**
 * The cost check against the production's cap. `needsUsd` is the job's
 * estimate at the vendor; in a credits workspace it is billed as whole
 * credits at the engine's margin, like everything else — or, given the exact
 * terms the job's reservation will charge (currentBillingTerms), at those.
 */
export async function checkCap(projectId: string | null, needsUsd: number, engine: EstimateTerms, band = 1): Promise<CapVerdict> {
  if (!projectId) return { allow: true, pct: null, warned: false };
  const row = await projectCap(projectId);
  if (!row || row.cap == null) return { allow: true, pct: null, warned: false };
  const pc = await withSpent(projectId, row);
  /* `band`: a take that holds its ceiling (Cinema Studio, lib/cinemaHold.ts) counts at its hold, not its estimate. */
  const hold = Number.isInteger(band) && band > 1 ? band : 1;
  const needs = pc.unit === "cr" ? creditsFor(needsUsd, engine) * hold : needsUsd * hold;
  const ruleRaw = await getSetting("atCap");
  const rule: CapRule = ruleRaw === "stop" || ruleRaw === "warn" ? ruleRaw : "producer";
  const warnPct = cleanWarnPct(await getSetting("capWarnPct"));
  const v = capVerdict({ cap: pc.cap, spent: pc.spent, needs, rule, unlocked: pc.unlocked, warnPct, unit: pc.unit });
  if (v.allow && v.warned && !pc.warnedAt) {
    // Once per cap: the producer hears when the threshold is first crossed, not on every take after it.
    await db().execute({ sql: `UPDATE projects SET cap_warned_at = ? WHERE id = ? AND cap_warned_at IS NULL`, args: [now(), projectId] }).catch(() => {});
    const ws = currentTenant()?.workspace;
    if (ws) {
      workspaceAdmins(ws.id)
        .then((admins) => notify("capNear", admins.map((a) => a.id), { title: `${pc.name} is at ${v.pct}% of its cap`, body: v.notice ?? "", url: `/projects/${projectId}` }))
        .catch(() => {});
    }
  }
  return v;
}

/**
 * Whether the next paid job of a production reaches the pause at a share of its budget (`budgetPause`), reckoned as
 * the gate reckons spend (`projectCapSpent`). Credits workspaces only; null when there is no cap, the production is
 * unlocked past its cap by an admin, or the job does not reach the pause. The sentence is what the run says.
 */
export async function budgetAsk(projectId: string | null, needsCredits: number): Promise<{ pause: BudgetPause; line: string } | null> {
  if (!projectId) return null;
  const row = await projectCapSpent(projectId);
  /* An admin's unlock lets a production past its cap; below the cap the ask still stands (an unlock is never a
     standing exemption from the pause, and any change to the cap or the budget re-locks it: resetCapLocks). */
  if (!row || row.unit !== "cr" || row.cap == null || (row.unlocked && row.spent >= row.cap)) return null;
  const pause = budgetPause({ cap: row.cap, spent: row.spent, needs: needsCredits, warnPct: cleanWarnPct(await getSetting("capWarnPct")) });
  if (!pause || !pause.reached) return null;
  return { pause, line: budgetPauseLine(pause) };
}

/* One write transaction on the workspace's database: a cap or budget and its re-lock land together, and an unlock is
   checked against the cap and budget it reads in the same transaction (SQLite serialises writers). */
async function inWrite<T>(fn: (tx: Awaited<ReturnType<ReturnType<typeof db>["transaction"]>>) => Promise<T>): Promise<T> {
  await ready();
  const tx = await db().transaction("write");
  try { const value = await fn(tx); await tx.commit(); return value; }
  catch (error) { await tx.rollback().catch(() => {}); throw error; }
  finally { tx.close(); }
}

/**
 * An unlock (and the once-per-cap warning) belongs to the cap it was given for. A production's own cap is written
 * with its re-lock in ONE statement, so a new cap never stands beside an old unlock: a changed cap re-locks the row
 * and re-arms its warning; the same cap written again changes neither.
 */
export async function setOwnCap(projectId: string, unit: CapUnit, value: number | null): Promise<void> {
  const col = unit === "cr" ? "cap_credits" : "cap_usd";
  await ready();
  await db().execute({
    sql: `UPDATE projects SET cap_unlocked = CASE WHEN ${col} IS ? THEN cap_unlocked ELSE 0 END, cap_warned_at = NULL, ${col} = ? WHERE id = ?`,
    args: [value, value, projectId],
  });
}

/**
 * The workspace's budget per production, written with its re-lock in ONE transaction: when the budget changes, every
 * production that follows it (no cap of its own) is re-locked and its warning re-armed. A workspace not billed in
 * credits has no budget to enforce, so nothing there is re-locked. Returns whether the budget changed.
 */
export async function setWorkspaceBudget(value: string, userId: string, inCredits: boolean): Promise<boolean> {
  const changed = await inWrite(async (tx) => {
    const before = (await tx.execute({ sql: "SELECT value FROM settings WHERE key = 'productionBudgetCredits'", args: [] })).rows[0];
    const was = cleanBudget(before?.value ?? ""), next = cleanBudget(value);
    await tx.execute({
      sql: `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('productionBudgetCredits',?,?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
      args: [value, userId, now()],
    });
    if (was === next) return false;
    if (inCredits) await tx.execute({ sql: "UPDATE projects SET cap_unlocked = 0, cap_warned_at = NULL WHERE cap_credits IS NULL", args: [] });
    return true;
  });
  invalidateSettings();
  return changed;
}

/** Re-locks a production (an admin's Lock again, or a test's set-up): never unlocks anything. */
export async function resetCapLocks(scope: { projectId: string } | { budget: true }): Promise<void> {
  await ready();
  if ("projectId" in scope) {
    await db().execute({ sql: "UPDATE projects SET cap_unlocked = 0, cap_warned_at = NULL WHERE id = ?", args: [scope.projectId] });
  } else {
    await db().execute("UPDATE projects SET cap_unlocked = 0, cap_warned_at = NULL WHERE cap_credits IS NULL");
  }
}

export const capChanged = (cap: number, unit: CapUnit) => `The cap changed to ${fmt(cap, unit)}: look again before unlocking.`;
export const NOT_AT_CAP = "This production is not at its cap, so there is nothing to unlock. Look again.";
export const NO_CAP = "This production has no cap to unlock.";

/**
 * An admin's Unlock, tied to the cap they were shown (`forCap`, in the workspace's unit): it lands only if that is still
 * the production's cap (its own, or the workspace's budget, read in the same write transaction as the unlock) and the
 * production is at it, as the gate counts spend. Otherwise it is refused with what changed, and nothing is written.
 */
export async function unlockAtCap(projectId: string, forCap: number): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const inCredits = creditsApply(currentTenant()?.workspace);
  const unit: CapUnit = inCredits ? "cr" : "$";
  const spent = (await spentBy("project_id", [projectId])).get(projectId)!;
  const used = inCredits ? spent.credits : spent.usd;
  return inWrite(async (tx) => {
    const row = (await tx.execute({ sql: "SELECT cap_credits, cap_usd FROM projects WHERE id = ?", args: [projectId] })).rows[0] as unknown as { cap_credits: unknown; cap_usd: unknown } | undefined;
    if (!row) return { ok: false as const, status: 404 as const, error: "No such project." };
    const budget = inCredits ? cleanBudget((await tx.execute({ sql: "SELECT value FROM settings WHERE key = 'productionBudgetCredits'", args: [] })).rows[0]?.value ?? "") : null;
    const own = inCredits ? (row.cap_credits == null ? null : Number(row.cap_credits)) : (row.cap_usd == null ? null : Number(row.cap_usd));
    const cap = own ?? budget;
    if (cap == null) return { ok: false as const, status: 409 as const, error: NO_CAP };
    if (Math.abs(cap - forCap) > 1e-9) return { ok: false as const, status: 409 as const, error: capChanged(cap, unit) };
    if (used + 1e-9 < cap) return { ok: false as const, status: 409 as const, error: NOT_AT_CAP };
    await tx.execute({ sql: "UPDATE projects SET cap_unlocked = 1 WHERE id = ?", args: [projectId] });
    return { ok: true as const };
  });
}

/**
 * A production's cap as every screen shows it, from its own row and the workspace's budget: the effective cap the
 * gate enforces (`capCredits`), whose it is (`capFrom`), and the production's own (`ownCapCredits`, what an admin
 * edits). Credits workspaces only; a dollars row is returned as it was.
 */
export function effectiveCapRow<R extends { capCredits: number | null }>(row: R, budget: number | null, inCredits: boolean):
  R & { capFrom: "production" | "workspace" | null; ownCapCredits: number | null } {
  if (!inCredits) return { ...row, capFrom: row.capCredits != null ? "production" : null, ownCapCredits: row.capCredits };
  const own = row.capCredits;
  return { ...row, capCredits: own ?? budget, capFrom: own != null ? "production" : budget != null ? "workspace" : null, ownCapCredits: own };
}
