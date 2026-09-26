import { db, ready, now } from "./db";
import { currentTenant } from "./tenant";
import { creditsApply } from "./credits";
import { billCredits, marginKeyOf } from "./creditTerms";
import { getSetting } from "./settings";
import { workspaceAdmins, platformDb, platformReady } from "./platform";
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
        rows.set(String(r.id), { key: r.k == null ? null : String(r.k), usd: cost, credits: billCredits(cost, marginKeyOf(String(r.kind), String(r.model))) });
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
        rows.set(id, { key: m.key ?? prior?.key ?? null, usd: Math.max(prior?.usd ?? 0, m.usd), credits: Math.max(prior?.credits ?? 0, m.credits) });
      }
    } catch { /* without the platform record, the takes alone */ }
  }
  for (const r of rows.values()) {
    const total = r.key == null ? undefined : out.get(r.key);
    if (total) { total.usd += r.usd; total.credits += r.credits; }
  }
  return out;
}

/** The production's cap and what it has spent, in the workspace's unit. */
export async function projectCap(projectId: string): Promise<ProjectCap | null> {
  await ready();
  const inCredits = creditsApply(currentTenant()?.workspace);
  const rs = await db().execute({
    sql: `SELECT p.name, p.cap_usd, p.cap_credits, p.cap_unlocked, p.cap_warned_at FROM projects p WHERE p.id = ?`,
    args: [projectId],
  });
  const r = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  if (!r) return null;
  const spent = (await spentBy("project_id", [projectId])).get(projectId)!;
  return {
    unit: inCredits ? "cr" : "$",
    cap: inCredits ? (r.cap_credits == null ? null : Number(r.cap_credits)) : (r.cap_usd == null ? null : Number(r.cap_usd)),
    unlocked: Number(r.cap_unlocked ?? 0) === 1,
    spent: inCredits ? spent.credits : spent.usd,
    warnedAt: r.cap_warned_at == null ? null : Number(r.cap_warned_at),
    name: String(r.name ?? ""),
  };
}

/**
 * The cost check against the production's cap. `needsUsd` is the job's
 * estimate at the vendor; in a credits workspace it is billed as whole
 * credits at the engine's margin, like everything else.
 */
export async function checkCap(projectId: string | null, needsUsd: number, engine: string | null): Promise<CapVerdict> {
  if (!projectId) return { allow: true, pct: null, warned: false };
  const pc = await projectCap(projectId);
  if (!pc || pc.cap == null) return { allow: true, pct: null, warned: false };
  const needs = pc.unit === "cr" ? billCredits(needsUsd, engine) : needsUsd;
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
