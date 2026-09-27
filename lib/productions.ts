import { db, ready, id as newId, now } from "./db";
import { billedCreditsSum } from "./creditSql";
import { STEPS } from "@/components/ui/Stepper";

/**
 * Productions › Projects (design/particl-v2/README.md §1, §6, §15).
 *
 * A production is the client job; a project is a deliverable inside it —
 * the 30s hero, the 15s cutdown, the 9:16 socials — each with its own six
 * steps, cap and need-you count. Shots, takes, cap and spend already hang
 * off `projects`, which is §15's `project` to the letter; what §15 adds is
 * the level above, and this file is that level: the `productions` table,
 * the one-per-existing-project backfill that puts every project under a
 * production once, and the read that assembles board 7a — productions with
 * their projects, the counts and the money — in one pass.
 *
 * Names are §15's: `productions` above `projects`. `projects` is never
 * renamed; it gained `production_id`, `format` and `step`.
 */

export type ProductionStatus = "active" | "delivered";

export type ProjectRow = {
  id: string; productionId: string; name: string; format: string; runtimeSecs: number | null;
  /** Index into the six steps: Brief · Shots · Boards · Takes · Approve · Deliver. */
  step: number;
  shots: number; capCredits: number | null; capUsd: number | null; spentCredits: number; spentUsd: number;
  needYou: number; mediaCount: number; createdAt: number;
};

export type ProductionRow = {
  id: string; name: string; client: string; status: ProductionStatus;
  capCredits: number | null; capUsd: number | null; spentCredits: number; spentUsd: number;
  needYou: number; createdAt: number; projects: ProjectRow[];
};

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Row = any;

const cleanStatus = (v: unknown): ProductionStatus => (v === "delivered" ? "delivered" : "active");
export const cleanStep = (v: unknown): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(STEPS.length - 1, n)) : 0;
};

/** The old free-text `stage` a production carried, read as a step index. */
export function stepFromStage(stage: string | null | undefined): number {
  const s = (stage ?? "").toLowerCase();
  if (s.startsWith("deliver")) return 5;
  if (s.includes("review") || s.includes("approv")) return 4;
  if (s.includes("take") || s.includes("render")) return 3;
  if (s.includes("board")) return 2;
  if (s.includes("shot")) return 1;
  return 0;
}

/** The list for a workspace on credits: the vendor's dollars withheld, credits kept. */
export function withoutVendorSpend(list: ProductionRow[]): ProductionRow[] {
  return list.map((p) => ({ ...p, spentUsd: 0, projects: p.projects.map((j) => ({ ...j, spentUsd: 0 })) }));
}

/** Board 7a in one read: productions, their projects, counts and money. */
export async function listProductions(): Promise<ProductionRow[]> {
  await ready();
  const [prods, projs] = await Promise.all([
    db().execute(`SELECT * FROM productions ORDER BY created_at DESC`),
    db().execute(`
      SELECT p.id, p.production_id, p.name, p.format, p.runtime_target, p.step, p.cap_credits, p.cap_usd, p.created_at,
             (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id) AS shots,
             COALESCE(g.n, 0) AS media, COALESCE(g.spend, 0) AS spend, COALESCE(g.credits, 0) AS credits,
             COALESCE(g.need, 0) AS need
      FROM projects p
      LEFT JOIN (
        SELECT project_id,
               SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS n,
               COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)), 0) AS spend,
               ${billedCreditsSum()} AS credits,
               SUM(CASE WHEN deleted = 0 AND status = 'succeeded' AND review_state = 'picked' THEN 1 ELSE 0 END) AS need
        FROM generations GROUP BY project_id
      ) g ON g.project_id = p.id
      ORDER BY p.created_at ASC`),
  ]);
  const byProd = new Map<string, ProjectRow[]>();
  for (const r of projs.rows as Row[]) {
    const row: ProjectRow = {
      id: String(r.id), productionId: String(r.production_id ?? ""), name: String(r.name), format: String(r.format ?? ""),
      runtimeSecs: r.runtime_target == null ? null : Number(r.runtime_target), step: cleanStep(r.step),
      shots: Number(r.shots ?? 0), capCredits: r.cap_credits == null ? null : Number(r.cap_credits), capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
      spentCredits: Number(r.credits ?? 0), spentUsd: Number(r.spend ?? 0), needYou: Number(r.need ?? 0), mediaCount: Number(r.media ?? 0),
      createdAt: Number(r.created_at ?? 0),
    };
    const list = byProd.get(row.productionId) ?? [];
    list.push(row); byProd.set(row.productionId, list);
  }
  return (prods.rows as Row[]).map((r) => {
    const projects = byProd.get(String(r.id)) ?? [];
    return {
      id: String(r.id), name: String(r.name), client: String(r.client ?? ""), status: cleanStatus(r.status),
      capCredits: r.cap_credits == null ? null : Number(r.cap_credits), capUsd: r.cap_usd == null ? null : Number(r.cap_usd),
      spentCredits: projects.reduce((a, p) => a + p.spentCredits, 0), spentUsd: projects.reduce((a, p) => a + p.spentUsd, 0),
      needYou: projects.reduce((a, p) => a + p.needYou, 0), createdAt: Number(r.created_at ?? 0), projects,
    };
  });
}

export async function createProduction(input: { name: string; client?: string; capCredits?: number | null; capUsd?: number | null }): Promise<string> {
  await ready();
  const pid = newId("prod");
  await db().execute({
    sql: `INSERT INTO productions (id, name, client, status, cap_credits, cap_usd, created_at) VALUES (?,?,?,?,?,?,?)`,
    args: [pid, input.name.trim().slice(0, 120), (input.client ?? "").trim().slice(0, 120), "active", input.capCredits ?? null, input.capUsd ?? null, now()],
  });
  return pid;
}

export async function patchProduction(pid: string, patch: { name?: string; client?: string; status?: ProductionStatus; capCredits?: number | null; capUsd?: number | null }): Promise<boolean> {
  await ready();
  const sets: string[] = []; const args: unknown[] = [];
  if (typeof patch.name === "string") { sets.push("name = ?"); args.push(patch.name.trim().slice(0, 120)); }
  if (typeof patch.client === "string") { sets.push("client = ?"); args.push(patch.client.trim().slice(0, 120)); }
  if (patch.status) { sets.push("status = ?"); args.push(cleanStatus(patch.status)); }
  if (patch.capCredits !== undefined) { sets.push("cap_credits = ?"); args.push(patch.capCredits); }
  if (patch.capUsd !== undefined) { sets.push("cap_usd = ?"); args.push(patch.capUsd); }
  if (!sets.length) return true;
  args.push(pid);
  const r = await db().execute({ sql: `UPDATE productions SET ${sets.join(", ")} WHERE id = ?`, args: args as never[] });
  return r.rowsAffected > 0;
}
