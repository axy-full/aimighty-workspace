import { db, ready } from "./db";
import { csvCell } from "./csvCell";
import { creditsApply } from "./credits";
import { modelLabel } from "./models";
import { platformDb, platformReady } from "./platform";
import { monthRange } from "./statements";
import { currentTenant, requireTenant, type TenantWorkspace } from "./tenant";
import { GROK_STT_MODEL } from "./xaiVoice";
import { consumerJobsReady } from "./higgsfield-consumer/jobs";
import {
  CONNECTED_LABEL, LEDGER_LABEL, connectedLedgerState, creditLedgerState, dollarLedgerState, workflowLabel,
  type ConnectedLedgerPage, type ConnectedLedgerRow, type CreditLedgerPage, type CreditLedgerRow, type DollarLedgerPage, type DollarLedgerRow,
} from "./usageLedgerTerms";
import type { Generation } from "./jobs";
import { accountFailure, parseOutcome, takeFailure } from "./providerOutcome";
import { billingSentence, failureCopy, failureUncharged } from "./errors";

/**
 * GET /api/usage?rows=1 — the usage ledger, one row per job, paged on the
 * server newest first (lib/usageLedgerTerms.ts has the shapes and words).
 *
 * A workspace on credits reads `meter_events`: the platform's own ledger of
 * what admission reserved and then settled or released, scoped to this
 * workspace. Only `billed_credits` is read — never the vendor's cost — so no
 * dollar figure can leave this path, in JSON or in the CSV. A workspace that
 * pays its vendors reads its takes (`generations`) in dollars, as the bars
 * above do. `?rows=connected` reads the viewer's own connected-account jobs,
 * in that provider's credits as quoted, apart from both.
 *
 * `?month=2026-09` (UTC, as statements count), `?cursor=` for the next page,
 * `?limit=` (1–100), `?id=` for one job (the Inspector), `?format=csv` for the
 * whole filter as a file under the same scope and unit rules.
 */
const PAGE = 50;
const MAX_PAGE = 100;
const CSV_PAGE = 1000;
const CSV_MAX = 100_000;
const CHARGE = "CASE WHEN paid_by_platform=1 THEN COALESCE(billed_credits,0) ELSE 0 END";
/* A take a dollar workspace paid for: not the connected account's (its provider's credits, listed with
   ?rows=connected) and not the starter production's demo takes, which nobody rendered or paid for. */
const LISTED = `g.id NOT GLOB 'gen_hfc_*' AND NOT (json_valid(g.params) AND (COALESCE(json_extract(g.params,'$.consumerCreditUnit'),'')='higgsfield_credits' OR COALESCE(json_extract(g.params,'$.demo'),0)<>0))`;
/* A known refinement charge cannot settle an unknown render charge. */
const DOLLARS = "CASE WHEN g.cost_usd IS NULL THEN NULL ELSE g.cost_usd+COALESCE(g.refine_cost_usd,0) END";
/* A take discarded while held, before it was ever sent (lib/held.ts): no provider could have charged for it. */
const DISCARDED = "CASE WHEN g.status='cancelled' AND json_valid(g.params) THEN json_extract(g.params,'$.discardedAt') END";
/* A failed take's recorded zero is Particl's own metering, not its provider's word: "not billed" needs the provider's
   own recorded outcome on the workspace's key (refunded, not charged) or a take discarded before it was sent.
   The same evidence the rows read (dollarLedgerState, failureUncharged). */
const UNCHARGED = `(${DISCARDED} IS NOT NULL OR (json_valid(g.provider_outcome) AND json_extract(g.provider_outcome,'$.funding')='own'
  AND json_extract(g.provider_outcome,'$.billing.state') IN ('refunded','not_charged')))`;
const MONTH = (col: string) => `strftime('%Y-%m',datetime(${col}/1000,'unixepoch'))`;

type Cursor = { at: number; id: string };
/**
 * Who is reading. Everyone's spend by person is the owners' and admins' (the
 * rule /api/analytics keeps): a member reads every job and its amount, and a
 * name only on their own — a teammate's job says "Teammate".
 */
export type LedgerViewer = { id: string; admin: boolean };
const TEAMMATE = "Teammate";
const mayName = (viewer: LedgerViewer, author: string) => viewer.admin || author === viewer.id;
export function nameFor(viewer: LedgerViewer, author: string, names: Map<string, string>): string | null {
  if (!author) return null;
  return mayName(viewer, author) ? names.get(author) ?? null : TEAMMATE;
}
export type LedgerQuery = { source: "ledger" | "connected"; month: string | null; range: { from: number; to: number } | null; cursor: Cursor | null; limit: number; id: string | null; csv: boolean };

/** A page marker: the last row's time and id, opaque to the browser. */
export function encodeLedgerCursor(at: number, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString("base64url");
}
export function decodeLedgerCursor(raw: string): Cursor | null {
  if (!/^[A-Za-z0-9_-]{1,600}$/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value as unknown[];
    return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && typeof id === "string" && id.length > 0 && id.length <= 300
      ? { at, id } : null;
  } catch { return null; }
}

export function parseLedgerQuery(params: URLSearchParams): LedgerQuery | { error: string } {
  const rows = params.get("rows");
  if (rows !== "1" && rows !== "connected") return { error: "rows is 1 (this workspace's jobs) or connected (your connected account)." };
  const month = params.get("month") || null;
  const range = month ? monthRange(month) : null;
  if (month && !range) return { error: "A month looks like 2026-09." };
  const rawCursor = params.get("cursor");
  const cursor = rawCursor ? decodeLedgerCursor(rawCursor) : null;
  if (rawCursor && !cursor) return { error: "That page of the ledger is not valid. Start again from the first page." };
  const id = params.get("id");
  if (id != null && (!id || id.length > 300)) return { error: "Name one job by its id." };
  const asked = Number(params.get("limit") ?? PAGE);
  const limit = Number.isFinite(asked) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(asked))) : PAGE;
  return { source: rows === "1" ? "ledger" : "connected", month, range, cursor, limit, id, csv: params.get("format") === "csv" };
}

/** Where the filter, the job and the page marker land in a query, in that order. */
function filters(q: LedgerQuery, time: string, key: string, where: string[], args: (string | number)[], page = true) {
  if (q.range) { where.push(`${time}>=? AND ${time}<?`); args.push(q.range.from, q.range.to); }
  if (q.id) { where.push(`${key}=?`); args.push(q.id); }
  if (page && q.cursor) { where.push(`(${time}<? OR (${time}=? AND ${key}<?))`); args.push(q.cursor.at, q.cursor.at, q.cursor.id); }
}

function next<T extends { at: number; id: string }>(rows: T[], limit: number): { rows: T[]; next: string | null } {
  if (rows.length <= limit) return { rows, next: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: encodeLedgerCursor(last.at, last.id) };
}

/** What a metered job was, in the ledger's words. */
export function meteredEngine(kind: string, engine: string, model: string): string {
  if (engine === "vercel-sandbox") return "Astra render";
  if (model === GROK_STT_MODEL) return "Transcription";
  if (kind === "training") return "Identity training";
  if (kind === "text") return `Atomik · ${modelLabel(model)}`;
  return modelLabel(model);
}

/** The names a viewer may read: everyone's for owners and admins, a member's own otherwise. */
async function names(ids: string[], viewer: LedgerViewer): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => id && mayName(viewer, id)))];
  if (!wanted.length) return new Map();
  const rs = await db().execute({ sql: `SELECT id,name FROM users WHERE id IN (${wanted.map(() => "?").join(",")})`, args: wanted });
  return new Map(rs.rows.map((r) => [String(r.id), String(r.name)]));
}

type Spend = { n: number; spend: number; credits: number };
/**
 * GET /api/usage's `byPerson` under the same rule, largest `spend` first.
 * Owners and admins read a row per person by name. A member reads their own
 * row by name and the rest of the team as one "Teammate" row, so no
 * teammate's spend is told apart from another's.
 */
export async function spendByPerson(rows: (Spend & { author: string })[], viewer: LedgerViewer): Promise<(Spend & { name: string })[]> {
  const who = await names(rows.map((r) => r.author), viewer);
  const out = new Map<string, Spend & { name: string }>();
  for (const { author, n, spend, credits } of rows) {
    const key = author && !mayName(viewer, author) ? TEAMMATE : `id:${author}`;
    const row = out.get(key);
    if (row) Object.assign(row, { n: row.n + n, spend: row.spend + spend, credits: row.credits + credits });
    else out.set(key, { name: nameFor(viewer, author, who) ?? "Unknown", n, spend, credits });
  }
  return [...out.values()].sort((a, b) => b.spend - a.spend);
}

/* ── Credits: the meter ─────────────────────────────────────────────── */

async function creditRows(ws: TenantWorkspace, q: LedgerQuery, viewer: LedgerViewer): Promise<{ rows: CreditLedgerRow[]; next: string | null }> {
  const where = ["workspace_id=?"];
  const args: (string | number)[] = [ws.id];
  filters(q, "created_at", "id", where, args);
  const rs = await platformDb().execute({
    sql: `SELECT id,kind,engine,model,status,paid_by_platform,${CHARGE} AS credits,created_by,created_at FROM meter_events
          WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`,
    args: [...args, q.limit + 1],
  });
  const page = rs.rows;
  /* Who: the meter's own record, else the take it billed for (this workspace's database).
     Why a failed one failed: that take's recorded outcome — its kind only, never the provider's charge. */
  const unowned = page.filter((r) => r.created_by == null).map((r) => String(r.id));
  const failedIds = page.filter((r) => String(r.status) === "failed").map((r) => String(r.id));
  const authors = new Map<string, string>();
  const reasons = new Map<string, string>();
  const wanted = [...new Set([...unowned, ...failedIds])];
  if (wanted.length) {
    const gens = await db().execute({ sql: `SELECT id,created_by,provider_outcome FROM generations WHERE id IN (${wanted.map(() => "?").join(",")})`, args: wanted });
    for (const g of gens.rows) {
      if (g.created_by != null && unowned.includes(String(g.id))) authors.set(String(g.id), String(g.created_by));
      if (failedIds.includes(String(g.id))) reasons.set(String(g.id), failureCopy(takeFailure(g.provider_outcome == null ? null : parseOutcome(String(g.provider_outcome)), { credits: true }).kind).what);
    }
  }
  const author = (r: (typeof page)[number]) => (r.created_by != null ? String(r.created_by) : authors.get(String(r.id)) ?? "");
  const who = await names(page.map(author), viewer);
  return next(page.map((r) => {
    const credits = Number(r.credits ?? 0);
    return {
      id: String(r.id), at: Number(r.created_at), who: nameFor(viewer, author(r), who),
      engine: meteredEngine(String(r.kind), String(r.engine), String(r.model)), kind: String(r.kind),
      credits, state: creditLedgerState(String(r.status), credits, Number(r.paid_by_platform) === 1),
      ...(reasons.has(String(r.id)) ? { why: reasons.get(String(r.id)) } : {}),
    };
  }), q.limit);
}

async function creditMonths(ws: TenantWorkspace): Promise<string[]> {
  const rs = await platformDb().execute({ sql: `SELECT ${MONTH("created_at")} AS m FROM meter_events WHERE workspace_id=? GROUP BY m ORDER BY m DESC LIMIT 36`, args: [ws.id] });
  return rs.rows.map((r) => String(r.m));
}

async function creditTotals(ws: TenantWorkspace, q: LedgerQuery): Promise<CreditLedgerPage["totals"]> {
  const where = ["workspace_id=?"];
  const args: (string | number)[] = [ws.id];
  filters({ ...q, id: null }, "created_at", "id", where, args, false);
  const rs = await platformDb().execute({
    sql: `SELECT COUNT(*) AS jobs,
                 COALESCE(SUM(CASE WHEN status<>'running' THEN ${CHARGE} ELSE 0 END),0) AS charged,
                 COALESCE(SUM(CASE WHEN status='running' THEN ${CHARGE} ELSE 0 END),0) AS held,
                 COALESCE(SUM(CASE WHEN status IN ('succeeded','failed') AND ${CHARGE}<=0 THEN 1 ELSE 0 END),0) AS not_billed
          FROM meter_events WHERE ${where.join(" AND ")}`,
    args,
  });
  const r = rs.rows[0];
  return { jobs: Number(r?.jobs ?? 0), charged: Number(r?.charged ?? 0), held: Number(r?.held ?? 0), notBilled: Number(r?.not_billed ?? 0) };
}

/* ── Dollars: the workspace's own takes ─────────────────────────────── */

async function dollarRows(q: LedgerQuery, viewer: LedgerViewer): Promise<{ rows: DollarLedgerRow[]; next: string | null }> {
  const where = [LISTED];
  const args: (string | number)[] = [];
  filters(q, "g.created_at", "g.id", where, args);
  const rs = await db().execute({
    sql: `SELECT g.id,g.kind,g.model,g.status,g.created_at,g.created_by,g.provider_outcome,${DOLLARS} AS usd,${DISCARDED} AS discarded
          FROM generations g WHERE ${where.join(" AND ")} ORDER BY g.created_at DESC,g.id DESC LIMIT ?`,
    args: [...args, q.limit + 1],
  });
  const author = (r: (typeof rs.rows)[number]) => (r.created_by == null ? "" : String(r.created_by));
  const who = await names(rs.rows.map(author), viewer);
  return next(rs.rows.map((r) => {
    const usd = r.usd == null ? null : Number(r.usd);
    /* The workspace pays its vendors: a failed take's provider outcome is its own money, in the provider's unit. */
    const failure = r.status === "failed" || r.status === "cancelled"
      ? takeFailure(r.provider_outcome == null ? null : parseOutcome(String(r.provider_outcome)), { credits: false }) : null;
    /* "Not billed" on evidence only: the provider's own recorded word, or a take discarded before it was sent. */
    const uncharged = failureUncharged(failure) || r.discarded != null;
    return {
      id: String(r.id), at: Number(r.created_at), who: nameFor(viewer, author(r), who),
      engine: modelLabel(String(r.model)), kind: String(r.kind ?? "video"), usd, state: dollarLedgerState(String(r.status), usd, uncharged),
      ...(failure ? { why: failureCopy(failure.kind, failure.payer).what, provider: failure.billing ? billingSentence(failure.billing, failure.provider) : null } : {}),
    };
  }), q.limit);
}

async function dollarMonths(): Promise<string[]> {
  const rs = await db().execute(`SELECT ${MONTH("g.created_at")} AS m FROM generations g WHERE ${LISTED} GROUP BY m ORDER BY m DESC LIMIT 36`);
  return rs.rows.map((r) => String(r.m));
}

async function dollarTotals(q: LedgerQuery): Promise<DollarLedgerPage["totals"]> {
  const where = [LISTED];
  const args: (string | number)[] = [];
  filters({ ...q, id: null }, "g.created_at", "g.id", where, args, false);
  const rs = await db().execute({
    sql: `SELECT COUNT(*) AS jobs,
                 COALESCE(SUM(CASE WHEN g.status IN ('succeeded','failed','cancelled') THEN COALESCE(${DOLLARS},0) ELSE 0 END),0) AS charged,
                 COALESCE(SUM(CASE WHEN (g.status IN ('failed','cancelled') AND COALESCE(${DOLLARS},0)<=0 AND ${UNCHARGED})
                                    OR (g.status='succeeded' AND ${DOLLARS} IS NOT NULL AND ${DOLLARS}<=0) THEN 1 ELSE 0 END),0) AS not_billed
          FROM generations g WHERE ${where.join(" AND ")}`,
    args,
  });
  const r = rs.rows[0];
  return { jobs: Number(r?.jobs ?? 0), charged: Number(r?.charged ?? 0), notBilled: Number(r?.not_billed ?? 0) };
}

/* ── The viewer's connected account: the provider's credits, as quoted ── */

/* Only a durable dispatch claim is an approved commitment (lib/higgsfield-consumer/activity.ts). */
const ADMITTED = "j.user_id=? AND j.dispatch_claim_hash IS NOT NULL AND j.status<>'quoted'";

async function connectedRows(userId: string, q: LedgerQuery): Promise<{ rows: ConnectedLedgerRow[]; next: string | null }> {
  const where = [ADMITTED];
  const args: (string | number)[] = [userId];
  filters(q, "j.created_at", "j.id", where, args);
  const rs = await db().execute({
    sql: `SELECT j.id,j.workflow,j.status,j.quote_credits,j.created_at,j.failure_code,j.provider_outcome,SUBSTR(p.name,1,200) AS project
          FROM higgsfield_consumer_jobs j LEFT JOIN workbench_projects p ON p.owner=j.user_id AND p.project_id=j.draft_id
          WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`,
    args: [...args, q.limit + 1],
  });
  return next(rs.rows.map((r) => {
    /* The viewer's own account: what it said, and what its own ledger shows for the charge, in its credits. */
    const failure = r.status === "failed"
      ? accountFailure(r.provider_outcome == null ? null : parseOutcome(String(r.provider_outcome)), r.failure_code == null ? null : String(r.failure_code)) : null;
    return {
      id: String(r.id), at: Number(r.created_at), workflow: workflowLabel(String(r.workflow)),
      project: r.project == null ? null : String(r.project), quotedCredits: Number(r.quote_credits ?? 0), state: connectedLedgerState(String(r.status)),
      ...(failure ? { why: failureCopy(failure.kind, failure.payer).what, provider: failure.billing ? billingSentence(failure.billing, failure.provider) : null } : {}),
    };
  }), q.limit);
}

async function connectedMonths(userId: string): Promise<string[]> {
  const rs = await db().execute({ sql: `SELECT ${MONTH("j.created_at")} AS m FROM higgsfield_consumer_jobs j WHERE ${ADMITTED} GROUP BY m ORDER BY m DESC LIMIT 36`, args: [userId] });
  return rs.rows.map((r) => String(r.m));
}

async function connectedTotals(userId: string, q: LedgerQuery): Promise<ConnectedLedgerPage["totals"]> {
  const where = [ADMITTED];
  const args: (string | number)[] = [userId];
  filters({ ...q, id: null }, "j.created_at", "j.id", where, args, false);
  const rs = await db().execute({ sql: `SELECT COUNT(*) AS jobs,COALESCE(SUM(j.quote_credits),0) AS quoted FROM higgsfield_consumer_jobs j WHERE ${where.join(" AND ")}`, args });
  return { jobs: Number(rs.rows[0]?.jobs ?? 0), quoted: Number(rs.rows[0]?.quoted ?? 0) };
}

/* ── A failed take's charge, from the ledger ─────────────────────────── */

/**
 * What Particl's own ledger holds for each failed take of a page, for a
 * workspace on credits: the credits the meter holds for it and whether that
 * is settled. Only work the platform funded is annotated (a job on the
 * workspace's own key paid no credits: its provider's own outcome speaks).
 * One read of `meter_events` for the page, `billed_credits` only — never the
 * vendor's cost. Returns the same array, annotated in place of a copy.
 */
export async function withLedgerCharges<G extends Pick<Generation, "id" | "status" | "failure">>(generations: G[]): Promise<G[]> {
  const ws = currentTenant()?.workspace;
  if (!ws || !creditsApply(ws)) return generations;
  const failed = generations.filter((g) => g.failure && (g.status === "failed" || g.status === "cancelled"));
  if (!failed.length) return generations;
  try {
    await platformReady();
    const ids = [...new Set(failed.map((g) => g.id))].slice(0, 500);
    const rs = await platformDb().execute({
      sql: `SELECT id,status,paid_by_platform,${CHARGE} AS credits FROM meter_events WHERE workspace_id=? AND id IN (${ids.map(() => "?").join(",")})`,
      args: [ws.id, ...ids],
    });
    const byId = new Map(rs.rows.map((r) => [String(r.id), r]));
    return generations.map((g) => {
      const row = g.failure ? byId.get(g.id) : undefined;
      if (!row || Number(row.paid_by_platform) !== 1) return g;
      return { ...g, failure: { ...g.failure!, charge: { credits: Number(row.credits ?? 0), settled: String(row.status) !== "running" } } };
    });
  } catch {
    /* The take still shows why it failed; its charge line waits for the ledger. */
    return generations;
  }
}

/* ── Pages, files, the response ─────────────────────────────────────── */

/** One page of the ledger in this workspace's unit. The first page also carries the months and the filter's totals. */
export async function usageLedgerPage(q: LedgerQuery, viewer: LedgerViewer): Promise<CreditLedgerPage | DollarLedgerPage> {
  await ready();
  const ws = requireTenant();
  const first = !q.cursor && !q.id;
  if (creditsApply(ws)) {
    await platformReady();
    const [page, months, totals] = await Promise.all([creditRows(ws, q, viewer), first ? creditMonths(ws) : null, first ? creditTotals(ws, q) : null]);
    return { unit: "credits", month: q.month, ...(months ? { months } : {}), ...(totals ? { totals } : {}), rows: page.rows, next: page.next };
  }
  const [page, months, totals] = await Promise.all([dollarRows(q, viewer), first ? dollarMonths() : null, first ? dollarTotals(q) : null]);
  return { unit: "usd", month: q.month, ...(months ? { months } : {}), ...(totals ? { totals } : {}), rows: page.rows, next: page.next };
}

export async function connectedLedgerPage(userId: string, q: LedgerQuery): Promise<ConnectedLedgerPage> {
  await consumerJobsReady();
  const first = !q.cursor && !q.id;
  const [page, months, totals] = await Promise.all([
    connectedRows(userId, q), first ? connectedMonths(userId) : null, first ? connectedTotals(userId, q) : null,
  ]);
  return {
    unit: "higgsfield_credits", basis: "approved_quotes", scope: "own_account", month: q.month,
    ...(months ? { months } : {}), ...(totals ? { totals } : {}), rows: page.rows, next: page.next,
  };
}

const stamp = (at: number) => { const iso = new Date(at).toISOString(); return [iso.slice(0, 10), iso.slice(11, 16)]; };

/** The ledger as a spreadsheet: one row per job, in the page's unit. */
export function ledgerCsv(page: Pick<CreditLedgerPage, "unit" | "rows"> | Pick<DollarLedgerPage, "unit" | "rows"> | Pick<ConnectedLedgerPage, "unit" | "rows">): string {
  const lines: (string | number)[][] = [];
  if (page.unit === "higgsfield_credits") {
    lines.push(["date", "time_utc", "workflow", "project", "status", "connected_credits_quoted", "failure", "provider_charge"]);
    for (const r of page.rows) lines.push([...stamp(r.at), r.workflow, r.project ?? "", CONNECTED_LABEL[r.state], r.quotedCredits, r.why ?? "", r.provider ?? ""]);
  } else if (page.unit === "credits") {
    lines.push(["date", "time_utc", "who", "engine", "kind", "status", "credits", "failure"]);
    for (const r of page.rows) lines.push([...stamp(r.at), r.who ?? "", r.engine, r.kind, LEDGER_LABEL[r.state], r.credits, r.why ?? ""]);
  } else {
    lines.push(["date", "time_utc", "who", "engine", "kind", "status", "usd", "failure", "provider_charge"]);
    for (const r of page.rows) lines.push([...stamp(r.at), r.who ?? "", r.engine, r.kind, LEDGER_LABEL[r.state], r.usd == null ? "" : Math.round(r.usd * 10000) / 10000, r.why ?? "", r.provider ?? ""]);
  }
  return lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Every page of the filter, for a file. Refuses rather than truncating a ledger too long for one. */
async function everyRow<P extends { rows: unknown[]; next: string | null }>(q: LedgerQuery, read: (q: LedgerQuery) => Promise<P>): Promise<P | null> {
  let page = await read({ ...q, limit: CSV_PAGE, cursor: null, id: null });
  const rows = [...page.rows];
  while (page.next) {
    if (rows.length >= CSV_MAX) return null;
    page = await read({ ...q, limit: CSV_PAGE, cursor: decodeLedgerCursor(page.next), id: null });
    rows.push(...page.rows);
  }
  return { ...page, rows, next: null } as P;
}

const headers = { "Cache-Control": "private, no-store" };

export async function usageLedgerResponse(req: Request, viewer: LedgerViewer): Promise<Response> {
  const q = parseLedgerQuery(new URL(req.url).searchParams);
  if ("error" in q) return Response.json({ error: q.error }, { status: 400, headers });
  type AnyPage = CreditLedgerPage | DollarLedgerPage | ConnectedLedgerPage;
  const read = (query: LedgerQuery): Promise<AnyPage> => (q.source === "connected" ? connectedLedgerPage(viewer.id, query) : usageLedgerPage(query, viewer));
  if (!q.csv) return Response.json(await read(q), { headers });
  const all = await everyRow(q, read);
  if (!all) return Response.json({ error: "Too many jobs for one file. Export one month at a time." }, { status: 413, headers });
  const ws = requireTenant();
  const name = `${q.source === "connected" ? "connected-usage" : "usage"}-${ws.slug}-${q.month ?? "all"}.csv`;
  return new Response(ledgerCsv(all), {
    headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}
