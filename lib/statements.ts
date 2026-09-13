import { db, ready } from "./db";
import { csvCell } from "./csvCell";
import { requireTenant } from "./tenant";
import { creditsApply } from "./credits";
import { billCredits, marginKeyOf } from "./creditTerms";
import { platformDb, platformReady } from "./platform";
import { cycleBounds } from "./cycle";
import { modelLabel } from "./models";
import { creditFundingFor } from "./billingLedger";

/**
 * Statements: what a workspace was billed, itemised by production, shot
 * and take, for one calendar month (UTC), optionally one production.
 *
 * A workspace on the platform's keys reads a statement in credits — the
 * meter's own figure for every job it billed, and the same rounding for
 * takes made before the meter existed — with one dollar line at the
 * bottom for the packs it bought that month. It never sees what an engine
 * charged the platform. The studio's own workspace, which pays its vendors
 * directly, reads the same statement in dollars.
 */
export type StatementUnit = "cr" | "$";
export type StatementFunding = { included: number; purchased: number; bonus: number; other: number; unattributed: number };
export type StatementLine = {
  id: string; at: number; kind: "video" | "image" | "audio" | "text" | "training";
  /** SH010 v3 — the client-facing name of the take. */
  take: string; what: string; status: string; note: string;
  credits: number; usd: number;
  funding?: StatementFunding;
};
export type StatementShot = { code: string; title: string; lines: StatementLine[]; credits: number; usd: number };
export type StatementProject = {
  id: string | null; name: string; shots: StatementShot[]; loose: StatementLine[];
  credits: number; usd: number; takes: number;
};
export type Statement = {
  month: string; from: number; to: number; unit: StatementUnit;
  workspace: { name: string; slug: string };
  projectFilter: string | null;
  projects: StatementProject[];
  totals: { credits: number; usd: number; takes: number };
  packs: { count: number; credits: number; bonus: number; usd: number };
  funding?: StatementFunding;
};

/**
 * "2026-09" → the UTC month it names, or null for anything else.
 *
 * The bounds come from `lib/cycle.ts` now. A statement is still a calendar
 * month and this still refuses anything that is not one; what changed is that
 * the month's two edges are worked out in the same place the rest of the
 * product works them out, instead of a second time here.
 */
export function monthRange(month: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const { start, end } = cycleBounds(1, Date.UTC(y, mo - 1, 1));
  return { from: start, to: end };
}

export const monthOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** A row before grouping: the take, and where it sits. */
export type RawLine = StatementLine & {
  projectId: string | null; projectName: string; shotId: string | null; shotCode: string; shotTitle: string;
};

/** Productions by name with Unfiled last; shots by code; takes in the order they were made. */
export function groupLines(rows: RawLine[]): StatementProject[] {
  const byProject = new Map<string, StatementProject & { shotMap: Map<string, StatementShot> }>();
  for (const r of rows) {
    const key = r.projectId ?? "";
    let p = byProject.get(key);
    if (!p) {
      p = { id: r.projectId, name: r.projectId ? r.projectName : "Unfiled", shots: [], loose: [], credits: 0, usd: 0, takes: 0, shotMap: new Map() };
      byProject.set(key, p);
    }
    const line: StatementLine = { id: r.id, at: r.at, kind: r.kind, take: r.take, what: r.what, status: r.status, note: r.note, credits: r.credits, usd: r.usd, ...(r.funding ? { funding: r.funding } : {}) };
    if (r.shotId && r.shotCode) {
      let s = p.shotMap.get(r.shotId);
      if (!s) { s = { code: r.shotCode, title: r.shotTitle, lines: [], credits: 0, usd: 0 }; p.shotMap.set(r.shotId, s); }
      s.lines.push(line); s.credits += line.credits; s.usd += line.usd;
    } else {
      p.loose.push(line);
    }
    p.credits += line.credits; p.usd += line.usd; p.takes += 1;
  }
  const out = [...byProject.values()].map((p) => {
    const shots = [...p.shotMap.values()].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
    for (const s of shots) s.lines.sort((a, b) => a.at - b.at);
    p.loose.sort((a, b) => a.at - b.at);
    const { shotMap: _drop, ...rest } = p; void _drop;
    return { ...rest, shots };
  });
  return out.sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name, "en")));
}


/** The statement as a spreadsheet: one row per take, subtotals, the packs line. */
export function statementCsv(s: Statement): string {
  const money = s.unit === "cr" ? "credits" : "usd";
  const rows: (string | number)[][] = [["date", "production", "shot", "take", "what", "status", money]];
  const amount = (l: StatementLine) => (s.unit === "cr" ? l.credits : Math.round(l.usd * 100) / 100);
  for (const p of s.projects) {
    for (const sh of p.shots) for (const l of sh.lines) rows.push([new Date(l.at).toISOString().slice(0, 10), p.name, `${sh.code}${sh.title ? ` ${sh.title}` : ""}`, l.take, l.what, l.status, amount(l)]);
    for (const l of p.loose) rows.push([new Date(l.at).toISOString().slice(0, 10), p.name, "", l.take, l.what, l.status, amount(l)]);
    rows.push(["", p.name, "", "", "subtotal", "", s.unit === "cr" ? p.credits : Math.round(p.usd * 100) / 100]);
  }
  rows.push([]);
  rows.push(["", "", "", "", "total", "", s.unit === "cr" ? s.totals.credits : Math.round(s.totals.usd * 100) / 100]);
  if (s.unit === "cr") {
    const free = s.packs.bonus > 0 ? ` (${s.packs.credits} bought + ${s.packs.bonus} free)` : "";
    rows.push(["", "", "", "", `packs this month (${s.packs.count})`, "", `${s.packs.credits + s.packs.bonus} credits${free} · USD ${s.packs.usd.toFixed(2)}`]);
    if (s.funding) {
      for (const [label, credits] of Object.entries(s.funding)) rows.push(["", "", "", "", `${label} credits used`, "", credits]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** The months with anything to bill, latest first. */
export async function statementMonths(): Promise<{ month: string; takes: number }[]> {
  await ready();
  const ws = requireTenant();
  const rs = await db().execute(`
    SELECT strftime('%Y-%m', datetime(created_at/1000, 'unixepoch')) AS m, COUNT(*) AS n
    FROM generations WHERE COALESCE(cost_usd, 0) > 0 OR status = 'succeeded'
    GROUP BY m ORDER BY m DESC LIMIT 24`);
  const months = new Map<string, number>();
  for (const r of rs.rows as unknown as { m: string; n: number }[]) months.set(String(r.m), Number(r.n));
  try {
    await platformReady();
    const mt = await platformDb().execute({
      sql: `SELECT strftime('%Y-%m', datetime(created_at/1000, 'unixepoch')) AS m, COUNT(*) AS n
            FROM meter_events WHERE workspace_id = ? AND COALESCE(billed_credits, 0) > 0 GROUP BY m`,
      args: [ws.id],
    });
    for (const r of mt.rows as unknown as { m: string; n: number }[]) if (!months.has(String(r.m))) months.set(String(r.m), Number(r.n));
  } catch { /* the platform record may be unreachable; the workspace's own months still list */ }
  return [...months.entries()].map(([month, takes]) => ({ month, takes })).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 24);
}

type GenRow = {
  id: string; created_at: number; kind: string | null; model: string; status: string; version: number | null; title: string | null;
  prompt: string; cost_usd: number | null; refine_cost_usd: number | null; params: string | null; project_id: string | null; shot_id: string | null;
  project_name: string | null; shot_code: string | null; shot_title: string | null;
};
type MeterRow = { id: string; kind: string; model: string; status: string; billed_credits: number | null; engine_cost_usd: number | null; project_id: string | null; shot_id: string | null; created_at: number };

/** One month's statement for this workspace, or one production of it. */
export async function statementFor(month: string, projectId: string | null): Promise<Statement | null> {
  const range = monthRange(month);
  if (!range) return null;
  await ready();
  const ws = requireTenant();
  const inCredits = creditsApply(ws);
  const unit: StatementUnit = inCredits ? "cr" : "$";
  const gens = await db().execute({
    sql: `SELECT g.id, g.created_at, g.kind, g.model, g.status, g.version, g.title, g.prompt, g.cost_usd, g.refine_cost_usd, g.params,
                 g.project_id, g.shot_id, p.name AS project_name, s.code AS shot_code, s.title AS shot_title
          FROM generations g LEFT JOIN projects p ON p.id = g.project_id LEFT JOIN shots s ON s.id = g.shot_id
          WHERE g.created_at >= ? AND g.created_at < ? ${projectId ? "AND g.project_id = ?" : ""}
          ORDER BY g.created_at ASC`,
    args: projectId ? [range.from, range.to, projectId] : [range.from, range.to],
  });
  const meter = new Map<string, MeterRow>();
  const extra: MeterRow[] = [];
  try {
    await platformReady();
    const mt = await platformDb().execute({
      sql: `SELECT id, kind, model, status, billed_credits, engine_cost_usd, project_id, shot_id, created_at
            FROM meter_events WHERE workspace_id = ? AND created_at >= ? AND created_at < ? ${projectId ? "AND project_id = ?" : ""}`,
      args: projectId ? [ws.id, range.from, range.to, projectId] : [ws.id, range.from, range.to],
    });
    for (const r of mt.rows as unknown as MeterRow[]) {
      if (r.kind === "text" || r.kind === "training") extra.push(r); else meter.set(String(r.id), r);
    }
  } catch { /* without the platform record, takes are still itemised at the same rounding */ }

  const projectNames = new Map<string, string>();
  const raw: RawLine[] = [];
  for (const r of gens.rows as unknown as GenRow[]) {
    const kind = (r.kind === "image" || r.kind === "audio" ? r.kind : "video") as RawLine["kind"];
    const usd = Number(r.cost_usd ?? 0) + Number(r.refine_cost_usd ?? 0);
    const m = meter.get(String(r.id));
    const credits = inCredits ? (m && m.billed_credits != null ? Number(m.billed_credits) : billCredits(usd, marginKeyOf(kind, r.model))) : 0;
    if (!(credits > 0) && !(usd > 0) && r.status !== "succeeded") continue;
    let p: { resolution?: string; duration?: number } = {};
    try { p = JSON.parse(r.params ?? "{}"); } catch { p = {}; }
    const size = p.resolution ? String(p.resolution).toUpperCase() : "";
    const what = [modelLabel(r.model), size, kind === "video" && p.duration ? `${p.duration}s` : ""].filter(Boolean).join(" · ");
    const v = r.version ?? 1;
    const take = kind === "image" ? `S${v}` : kind === "audio" ? "A" : `v${v}`;
    if (r.project_id && r.project_name) projectNames.set(r.project_id, r.project_name);
    raw.push({
      id: r.id, at: Number(r.created_at), kind, take, what, status: r.status, note: (r.title || r.prompt || "").slice(0, 80),
      credits, usd: inCredits ? 0 : usd,
      projectId: r.project_id, projectName: r.project_name ?? "", shotId: r.shot_id, shotCode: r.shot_code ?? "", shotTitle: r.shot_title ?? "",
    });
  }
  if (extra.length) {
    const ids = [...new Set(extra.map((e) => e.project_id).filter((x): x is string => Boolean(x)))].filter((id) => !projectNames.has(id));
    if (ids.length) {
      const rs = await db().execute({ sql: `SELECT id, name FROM projects WHERE id IN (${ids.map(() => "?").join(",")})`, args: ids });
      for (const r of rs.rows as unknown as { id: string; name: string }[]) projectNames.set(r.id, r.name);
    }
    for (const e of extra) {
      const credits = inCredits ? Number(e.billed_credits ?? 0) : 0;
      const usd = inCredits ? 0 : Number(e.engine_cost_usd ?? 0);
      if (!(credits > 0) && !(usd > 0)) continue;
      raw.push({
        id: e.id, at: Number(e.created_at), kind: e.kind as RawLine["kind"], take: e.kind === "training" ? "Training" : "Atomik",
        what: e.kind === "training" ? `Identity training · ${e.model}` : `Thinking · ${e.model}`, status: e.status, note: "",
        credits, usd, projectId: e.project_id, projectName: e.project_id ? projectNames.get(e.project_id) ?? "" : "", shotId: e.shot_id, shotCode: "", shotTitle: "",
      });
    }
  }
  let funding: StatementFunding | undefined;
  if (inCredits) {
    const sources = await creditFundingFor(ws.id, range.from, range.to);
    funding = { included: 0, purchased: 0, bonus: 0, other: 0, unattributed: 0 };
    for (const line of raw) {
      const split: StatementFunding = { included: 0, purchased: 0, bonus: 0, other: 0, unattributed: 0 };
      for (const source of sources.filter((s) => s.eventId === line.id)) {
        const key = source.kind === "included" ? "included" : source.kind === "purchase" ? "purchased" : source.kind === "bonus" ? "bonus" : source.kind === "legacy" ? "unattributed" : "other";
        split[key] += source.credits;
      }
      split.unattributed += Math.max(0, line.credits - Object.values(split).reduce((a, b) => a + b, 0));
      line.funding = split;
      for (const key of Object.keys(split) as (keyof StatementFunding)[]) funding[key] += split[key];
    }
  }
  const projects = groupLines(raw);
  let packs = { count: 0, credits: 0, bonus: 0, usd: 0 };
  if (inCredits) {
    try {
      /* BOTH halves. `credits` on this row is what was BOUGHT — §7A puts the
         discount in `bonus_credits` — and a statement that summed only the
         bought half would tell a workspace it received 20,000 credits in a
         month its balance went up by 24,000. This is the document a
         workspace sends to its own client, so it is the last place that can
         afford to disagree with the balance.
         Kept as two numbers rather than one total, which is what §7A's
         guardrail 5 asks of a statement: show what was free and what was
         paid. The dollar sum is unchanged, because the bonus is free. */
      const pk = await platformDb().execute({
        sql: `SELECT COUNT(*) AS n, COALESCE(SUM(credits), 0) AS c,
                     COALESCE(SUM(bonus_credits), 0) AS b, COALESCE(SUM(usd), 0) AS u
              FROM topup_requests WHERE workspace_id = ? AND status = 'approved' AND decided_at >= ? AND decided_at < ?`,
        args: [ws.id, range.from, range.to],
      });
      const r = pk.rows[0] as unknown as { n: number; c: number; b: number; u: number } | undefined;
      packs = { count: Number(r?.n ?? 0), credits: Number(r?.c ?? 0), bonus: Number(r?.b ?? 0), usd: Number(r?.u ?? 0) };
    } catch { /* no platform record, no packs line */ }
  }
  return {
    month, from: range.from, to: range.to, unit,
    workspace: { name: ws.name, slug: ws.slug },
    projectFilter: projectId,
    projects,
    totals: { credits: projects.reduce((a, p) => a + p.credits, 0), usd: projects.reduce((a, p) => a + p.usd, 0), takes: projects.reduce((a, p) => a + p.takes, 0) },
    packs, ...(funding ? { funding } : {}),
  };
}
