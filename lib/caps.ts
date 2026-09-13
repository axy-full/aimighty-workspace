import { db, ready, now } from "./db";
import { currentTenant } from "./tenant";
import { creditsApply } from "./credits";
import { billCreditsWith, multiplierFor, creditUsd } from "./creditTerms";
import { billedCreditsSum } from "./creditSql";
import { getSetting } from "./settings";
import { workspaceAdmins } from "./platform";
import { notify } from "./push";

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

export type ProjectCap = { unit: CapUnit; cap: number | null; unlocked: boolean; spent: number; warnedAt: number | null; name: string };

/** The production's cap and what it has spent, in the workspace's unit. */
export async function projectCap(projectId: string): Promise<ProjectCap | null> {
  await ready();
  const inCredits = creditsApply(currentTenant()?.workspace);
  const rs = await db().execute({
    sql: `SELECT p.name, p.cap_usd, p.cap_credits, p.cap_unlocked, p.cap_warned_at,
                 (SELECT COALESCE(SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)),0) FROM generations g WHERE g.project_id = p.id AND g.deleted = 0) AS spent_usd,
                 (SELECT ${billedCreditsSum("g")} FROM generations g WHERE g.project_id = p.id AND g.deleted = 0) AS spent_credits
          FROM projects p WHERE p.id = ?`,
    args: [projectId],
  });
  const r = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    unit: inCredits ? "cr" : "$",
    cap: inCredits ? (r.cap_credits == null ? null : Number(r.cap_credits)) : (r.cap_usd == null ? null : Number(r.cap_usd)),
    unlocked: Number(r.cap_unlocked ?? 0) === 1,
    spent: inCredits ? Number(r.spent_credits ?? 0) : Number(r.spent_usd ?? 0),
    warnedAt: r.cap_warned_at == null ? null : Number(r.cap_warned_at),
    name: String(r.name ?? ""),
  };
}

/** What a job counts against the cap, in the production's unit: whole credits at the workspace's multiplier — cost when it is flagged internal (§7A guardrail 6) — or the vendor's dollars. Pure. */
export function capNeeds(needsUsd: number, unit: CapUnit, engine: string | null | undefined, internal: boolean): number {
  return unit === "cr" ? billCreditsWith(needsUsd, multiplierFor(engine, internal), creditUsd()) : needsUsd;
}

/**
 * The cost check against the production's cap. `needsUsd` is the job's
 * estimate at the vendor; in a credits workspace it is billed as whole
 * credits at the workspace's multiplier, like everything else. The flag is
 * defaulted from the tenant in scope, so the routes that inline it need not know.
 */
export async function checkCap(projectId: string | null, needsUsd: number, engine: string | null, internal = currentTenant()?.workspace?.internal === true): Promise<CapVerdict> {
  if (!projectId) return { allow: true, pct: null, warned: false };
  const pc = await projectCap(projectId);
  if (!pc || pc.cap == null) return { allow: true, pct: null, warned: false };
  const needs = capNeeds(needsUsd, pc.unit, engine, internal);
  const ruleRaw = await getSetting("atCap");
  const rule: CapRule = ruleRaw === "stop" || ruleRaw === "warn" ? ruleRaw : "producer";
  const warnPct = Math.max(1, Math.min(100, Number(await getSetting("capWarnPct")) || 80));
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
