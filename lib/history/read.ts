import { creditsApply } from "../credits";
import { csvCell } from "../csvCell";
import { syncCreditReceipts } from "../creditReceipts";
import { db, ready } from "../db";
import { DRAFT_PROJECT_PREFIX, seesEveryBoard, takeLister } from "../draftProject";
import type { PublicCommand, PublicJob } from "../jobView";
import { JobsOffError } from "../quotedJobs/flag";
import { QuotedJobError, quotedJobs, type JobFilter, type PageMark, type QuotedJobStore } from "../quotedJobs/store";
import { assetLinkHref } from "../shell/asset-link";
import { monthRange } from "../statements";
import { requireTenant } from "../tenant";
import { TeamCanvasError, requireProduction } from "../workbench/team-canvas";
import { BEFORE_HISTORY, earlierBoards, earlierPage, type EarlierRecord } from "./earlier";
import { HistoryOffError, historyOn } from "./flag";

/**
 * v30 History read models (owner's 17 Oct brief, Phase A item 5; docs/plans/v30-data-model.md § 5; PR A9). Read-only:
 * nothing here writes a job, a command, a meter record or a charge.
 *
 *   - Agent: one row per instruction (the person's own words, the production, the step, the date, the total credits
 *     and the cards it made). No engine, model or provider anywhere: every job and instruction is read through the v30
 *     serializer (lib/jobView.ts), whose Agent output carries none, and an Agent row is built only from its fields
 *     that cannot hold one. An Agent job that belongs to no instruction is a row of its own. Work from before History
 *     is listed here too, with "before History" for what was never recorded (owner, 17 Oct, answer 15; ./earlier.ts):
 *     nothing before History says who decided, so no earlier row is ever a Director row or names an engine.
 *   - Director: one row per Director job, itemised: the engine it chose, its settings, inputs and prompt (the
 *     serializer's Director output; brief rule 1: "Director jobs expose everything they chose").
 *   - Aggregates: jobs and credits by production, by member and by calendar month (UTC), over every job and every
 *     piece of earlier work the viewer may see. The totals are the sums of the receipts the rows show.
 *   - CSV of each, every cell through lib/csvCell.ts.
 *
 * Money: the amounts are the workspace's receipts (`credit_receipts`, the meter's replica: "the meter remains
 * authoritative"), in credits, and only where credits apply. NO vendor cost, for anyone (it never leaves the platform
 * admin desk), no refund status and never the word: a refunded failure reads as its receipt (owner, 17 Oct: "A
 * refunded failure shows 0 cr on the receipt and the word refund never appears; vendor refunds stay internal").
 *
 * Who sees what (today's rules, as the Usage ledger keeps them, lib/usageLedger.ts): every member reads every job of
 * the workspace and its amount; a name only on their own work, a teammate's says "Teammate", and only an owner or
 * admin filters by a teammate or reads everyone's names. Work on a private board (lib/draftProject.ts) is left out for
 * whoever may not see that board's takes, in the query, so pages and totals are the viewer's own. A production named
 * in the query must be one the viewer may read (requireProduction): otherwise the same 404 as one that does not exist.
 *
 * Tenancy: the jobs store is the workspace's own (db() with requireTenant().id), the earlier work is read from the
 * meter records with `workspace_id` = the workspace in scope, and everything else from the workspace's own database.
 *
 * Behind `V30_HISTORY` AND `V30_JOBS`, both off by default (./flag.ts): off, a 404 before any database is opened.
 */

export class HistoryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HistoryError";
  }
}

export { BEFORE_HISTORY };

/** Who is reading: their id, whether they may read everyone's names (an owner or admin), and their role for boards. */
export type HistoryViewer = { id: string; admin: boolean; role?: string };

export type HistoryView = "agent" | "director" | "aggregates";
export const HISTORY_VIEWS: readonly HistoryView[] = ["agent", "director", "aggregates"];

export type HistoryQuery = {
  view: HistoryView;
  productionId: string | null;
  month: string | null;
  range: { from: number; to: number } | null;
  /** A member's id, or "me". */
  member: string | null;
  after: PageMark | null;
  limit: number;
  csv: boolean;
};

export type HistoryMember = { id: string | null; name: string | null; you: boolean };
export type HistoryProduction = { id: string | null; name: string | null };
/** A card a row made, and the link that opens it (null until the card has a page of its own to open on). */
export type HistoryCard = { takeId: string | null; nodeId: string | null; href: string | null };
type Credits = { credits: number } | null;

export type AgentRow = {
  /** An instruction, an Agent job of no instruction, or earlier work. */
  source: "command" | "job" | "earlier";
  id: string;
  /** The person's own words; "before History" for earlier work; null for a job that belongs to no instruction. */
  instruction: string | null;
  production: HistoryProduction;
  step: string | null;
  at: number;
  member: HistoryMember;
  state: string;
  quote: Credits;
  total: Credits;
  cards: HistoryCard[];
  /** The first card's link. */
  link: string | null;
};

export type DirectorRow = {
  id: string;
  production: HistoryProduction;
  step: string | null;
  at: number;
  member: HistoryMember;
  product: string;
  status: string;
  engine: { id: string; label: string } | null;
  settings: Record<string, string | number | boolean> | null;
  inputs: { ports: string[]; cast: string[] } | null;
  prompt: string | null;
  quote: Credits;
  actual: Credits;
  /** Our own sentence for a failure. */
  error: string | null;
  card: HistoryCard | null;
  link: string | null;
};

export type HistoryAggregate = { jobs: number; credits: number | null };
export type HistoryAggregates = {
  total: HistoryAggregate;
  byProduction: (HistoryAggregate & { production: HistoryProduction })[];
  byMember: (HistoryAggregate & { member: HistoryMember })[];
  byMonth: (HistoryAggregate & { month: string })[];
};

export type HistoryPage<R> = { view: HistoryView; unit: "credits" | null; rows: R[]; next: string | null };

const PAGE = 50;
const MAX_PAGE = 200;
const BATCH = 1000;
const CSV_PAGE = 500;
/** The most a file or a set of totals reads. Past it: "one month at a time", never a silently short answer. */
export const HISTORY_MAX_ROWS = 100_000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TEAMMATE = "Teammate";
/** Words about a vendor's refund: never in History. */
const REFUND = /refund/i;

/* ── the query ────────────────────────────────────────────────────────── */

export function encodeHistoryCursor(mark: PageMark): string {
  return Buffer.from(JSON.stringify([mark.at, mark.id])).toString("base64url");
}

export function decodeHistoryCursor(raw: string): PageMark | null {
  if (!/^[A-Za-z0-9_-]{1,600}$/.test(raw)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value as unknown[];
    return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && typeof id === "string" && id.length > 0 && id.length <= 300 ? { at, id } : null;
  } catch {
    return null;
  }
}

export function parseHistoryQuery(params: URLSearchParams): HistoryQuery | { error: string } {
  const view = (params.get("view") ?? "agent") as HistoryView;
  if (!HISTORY_VIEWS.includes(view)) return { error: "view is agent, director or aggregates." };
  const productionId = params.get("production") || null;
  if (productionId !== null && !ID.test(productionId)) return { error: "Name one project by its id." };
  const month = params.get("month") || null;
  const range = month ? monthRange(month) : null;
  if (month && !range) return { error: "A month looks like 2026-10." };
  const member = params.get("member") || null;
  if (member !== null && (member.length > 200 || /[\u0000-\u001f]/.test(member))) return { error: "Name one member by their id." };
  const raw = params.get("cursor");
  const after = raw ? decodeHistoryCursor(raw) : null;
  if (raw && !after) return { error: "That page of History is not valid. Start again from the first page." };
  const asked = Number(params.get("limit") ?? PAGE);
  const limit = Number.isFinite(asked) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(asked))) : PAGE;
  return { view, productionId, month, range, member, after, limit, csv: params.get("format") === "csv" };
}

/* ── the context every read shares ────────────────────────────────────── */

type Context = {
  store: QuotedJobStore;
  credits: boolean;
  viewer: HistoryViewer;
  workspaceId: string;
  /** The filter every source is read with (no page marker, no limit). */
  base: Omit<JobFilter, "after" | "limit">;
};

async function context(q: HistoryQuery, viewer: HistoryViewer): Promise<Context> {
  const ws = requireTenant();
  /* Both switches, History's first: off, nothing is opened. */
  if (!(await historyOn(ws))) throw new HistoryOffError();
  const store = await quotedJobs();
  const member = q.member === "me" ? viewer.id : q.member;
  /* One teammate's work, told apart from the rest, is the owners' and admins' (lib/usageLedger.ts). */
  if (member !== null && member !== viewer.id && !viewer.admin) throw new HistoryError("Only an owner or admin reads a teammate's History.", 403);
  if (q.productionId) await requireProduction(q.productionId, viewer.id, "read");
  const credits = creditsApply(ws);
  if (credits) await syncCreditReceipts();
  const visibleBoards = await boardsFor(viewer);
  return {
    store, credits, viewer, workspaceId: ws.id,
    base: {
      ...(q.productionId ? { productionId: q.productionId } : {}),
      ...(member !== null ? { createdBy: member } : {}),
      ...(q.range ? { from: q.range.from, to: q.range.to } : {}),
      ...(visibleBoards ? { visibleBoards } : {}),
    },
  };
}

/**
 * The private boards whose work this viewer may see, or undefined when every board's is (an owner or admin, as for
 * takes: lib/draftProject.ts seesEveryBoard). The read filters keep work of ordinary projects, of no project, and of
 * these boards only, so a board missing from this list is left out, never shown by default.
 */
async function boardsFor(viewer: HistoryViewer): Promise<string[] | undefined> {
  const person = { id: viewer.id, role: viewer.role ?? (viewer.admin ? "admin" : "member") };
  if (seesEveryBoard(person)) return undefined;
  await ready();
  const pattern = `${DRAFT_PROJECT_PREFIX}*`;
  const local = await db().execute({
    sql: "SELECT id FROM projects WHERE id GLOB ? UNION SELECT DISTINCT project_id FROM generations WHERE project_id GLOB ?",
    args: [pattern, pattern],
  });
  const candidates = new Set([...local.rows.map((r) => String(r.id)), ...(await earlierBoards())]);
  const listed = await takeLister(person);
  return [...candidates].filter((id) => listed(id));
}

/* ── names, productions, cards ────────────────────────────────────────── */

type Lookups = {
  member: (by: string) => HistoryMember;
  production: (id: string | null, earlier?: boolean) => HistoryProduction;
  card: (production: string | null, takeId: string | null, nodeId: string | null) => HistoryCard;
};

async function lookups(ctx: Context, people: string[], productions: (string | null)[]): Promise<Lookups> {
  await ready();
  const { viewer } = ctx;
  const nameable = [...new Set(people.filter((id) => id && (viewer.admin || id === viewer.id)))];
  const names = new Map<string, string>();
  if (nameable.length) {
    const rs = await db().execute({ sql: "SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))", args: [JSON.stringify(nameable)] });
    for (const r of rs.rows) names.set(String(r.id), String(r.name));
  }
  const wanted = [...new Set(productions.filter((id): id is string => !!id))];
  const projects = new Map<string, { name: string | null; production: string | null }>();
  if (wanted.length) {
    const rs = await db().execute({ sql: "SELECT id, name, production_id FROM projects WHERE id IN (SELECT value FROM json_each(?))", args: [JSON.stringify(wanted)] });
    for (const r of rs.rows) projects.set(String(r.id), { name: r.name == null ? null : String(r.name), production: r.production_id == null ? null : String(r.production_id) });
  }
  return {
    member: (by) => {
      if (!by) return { id: null, name: null, you: false };
      if (viewer.admin || by === viewer.id) return { id: by, name: names.get(by) ?? null, you: by === viewer.id };
      return { id: null, name: TEAMMATE, you: false };
    },
    production: (id, earlier = false) => (id ? { id, name: projects.get(id)?.name ?? null } : { id: null, name: earlier ? BEFORE_HISTORY : null }),
    /* A take opens where "Copy link" opens it (lib/shell/asset-link.ts): its workspace, its production and the take.
       A card that is not a take yet opens once v30 steps give it a page (PR A1/A2). */
    card: (production, takeId, nodeId) => ({
      takeId, nodeId,
      href: takeId && production
        ? assetLinkHref({ origin: "", workspace: ctx.workspaceId, production: projects.get(production)?.production ?? null, asset: `generation:${takeId}` })
        : null,
    }),
  };
}

const markOf = (row: { at: number; id: string }): PageMark => ({ at: row.at, id: row.id });
/** The order every source is read in: newest first, then id ascending. */
const order = (a: { at: number; id: string }, b: { at: number; id: string }) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every job a filter names, page by page; refused past HISTORY_MAX_ROWS rather than cut short. */
async function everyJob(store: QuotedJobStore, filter: Omit<JobFilter, "after" | "limit">): Promise<PublicJob[]> {
  const out: PublicJob[] = [];
  let after: PageMark | undefined;
  for (;;) {
    const page = await store.list({ ...filter, ...(after ? { after } : {}), limit: BATCH });
    out.push(...page);
    if (out.length > HISTORY_MAX_ROWS) throw new HistoryError("Too much History for one read. Ask for one month at a time.", 413);
    if (page.length < BATCH) return out;
    const last = page[page.length - 1];
    after = { at: last.createdAt, id: last.id };
  }
}

async function everyEarlier(ctx: Context): Promise<EarlierRecord[]> {
  const out: EarlierRecord[] = [];
  let after: PageMark | undefined;
  for (;;) {
    const page = await earlierPage({ ...earlierFilter(ctx), ...(after ? { after } : {}), limit: BATCH }, earlierOpts(ctx));
    out.push(...page.rows);
    if (out.length > HISTORY_MAX_ROWS) throw new HistoryError("Too much History for one read. Ask for one month at a time.", 413);
    if (!page.more || !page.rows.length) return out;
    const last = page.rows[page.rows.length - 1];
    after = { at: last.at, id: last.meterId };
  }
}

const earlierFilter = (ctx: Context) => ({
  ...(ctx.base.productionId ? { productionId: ctx.base.productionId } : {}),
  ...(ctx.base.createdBy ? { createdBy: ctx.base.createdBy } : {}),
  ...(ctx.base.from !== undefined ? { from: ctx.base.from, to: ctx.base.to } : {}),
  ...(ctx.base.visibleBoards ? { visibleBoards: ctx.base.visibleBoards } : {}),
});
const earlierOpts = (ctx: Context) => ({ credits: ctx.credits, claimed: (ids: string[]) => ctx.store.claimedMeters(ids) });

const credits = (ctx: Context, value: number | null | undefined): Credits => (ctx.credits ? { credits: value ?? 0 } : null);

/* ── Agent ────────────────────────────────────────────────────────────── */

type AgentSource =
  | { kind: "command"; at: number; id: string; command: PublicCommand }
  | { kind: "job"; at: number; id: string; job: PublicJob }
  | { kind: "earlier"; at: number; id: string; record: EarlierRecord };

async function agentRows(ctx: Context, sources: AgentSource[]): Promise<AgentRow[]> {
  const commandIds = sources.flatMap((s) => (s.kind === "command" ? [s.command.id] : []));
  const jobsOf = new Map<string, PublicJob[]>();
  for (let start = 0; start < commandIds.length; start += BATCH)
    for (const job of await everyJob(ctx.store, { commandIds: commandIds.slice(start, start + BATCH) })) {
      const list = jobsOf.get(job.commandId ?? "") ?? [];
      list.push(job);
      jobsOf.set(job.commandId ?? "", list);
    }
  const people = sources.map((s) => (s.kind === "command" ? s.command.createdBy : s.kind === "job" ? s.job.createdBy : s.record.createdBy));
  const productions = sources.map((s) => (s.kind === "command" ? s.command.productionId : s.kind === "job" ? s.job.productionId : s.record.productionId));
  const look = await lookups(ctx, people, productions);
  return sources.map((s): AgentRow => {
    if (s.kind === "command") {
      const c = s.command;
      /* The cards it made, oldest first, each once. */
      const cards = (jobsOf.get(c.id) ?? []).slice().reverse()
        .filter((j) => j.takeId || j.nodeId)
        .map((j) => look.card(c.productionId, j.takeId, j.nodeId));
      return {
        source: "command", id: c.id, instruction: c.instruction, production: look.production(c.productionId), step: c.stepId,
        at: c.createdAt, member: look.member(c.createdBy), state: c.state, quote: c.quote, total: c.total,
        cards, link: cards.find((card) => card.href)?.href ?? null,
      };
    }
    if (s.kind === "job") {
      const j = s.job;
      const cards = j.takeId || j.nodeId ? [look.card(j.productionId, j.takeId, j.nodeId)] : [];
      return {
        source: "job", id: j.id, instruction: null, production: look.production(j.productionId), step: j.stepId,
        at: j.createdAt, member: look.member(j.createdBy), state: j.status, quote: j.quote, total: credits(ctx, j.actual?.credits),
        cards, link: cards[0]?.href ?? null,
      };
    }
    const r = s.record;
    const cards = r.takeId ? [look.card(r.productionId, r.takeId, null)] : [];
    return {
      source: "earlier", id: r.meterId, instruction: BEFORE_HISTORY, production: look.production(r.productionId, true), step: BEFORE_HISTORY,
      at: r.at, member: look.member(r.createdBy), state: r.status ?? BEFORE_HISTORY, quote: null, total: credits(ctx, r.credits),
      cards, link: cards[0]?.href ?? null,
    };
  });
}

async function agentSources(ctx: Context, after: PageMark | null, limit: number): Promise<AgentSource[]> {
  const page = { ...(after ? { after } : {}), limit: limit + 1 };
  const [commands, jobs, earlier] = await Promise.all([
    ctx.store.commands({ ...ctx.base, ...page }),
    ctx.store.list({ ...ctx.base, decider: "agent", withoutCommand: true, ...page }),
    earlierPage({ ...earlierFilter(ctx), ...page }, earlierOpts(ctx)),
  ]);
  return [
    ...commands.map((command) => ({ kind: "command" as const, at: command.createdAt, id: command.id, command })),
    ...jobs.map((job) => ({ kind: "job" as const, at: job.createdAt, id: job.id, job })),
    ...earlier.rows.map((record) => ({ kind: "earlier" as const, at: record.at, id: record.meterId, record })),
  ].sort(order);
}

async function agentPage(ctx: Context, after: PageMark | null, limit: number): Promise<HistoryPage<AgentRow>> {
  const sources = await agentSources(ctx, after, limit);
  const shown = sources.slice(0, limit);
  const next = sources.length > limit ? encodeHistoryCursor(markOf(shown[shown.length - 1])) : null;
  return { view: "agent", unit: ctx.credits ? "credits" : null, rows: await agentRows(ctx, shown), next };
}

export async function agentHistory(q: HistoryQuery, viewer: HistoryViewer): Promise<HistoryPage<AgentRow>> {
  return agentPage(await context(q, viewer), q.after, q.limit);
}

/* ── Director ─────────────────────────────────────────────────────────── */

async function directorRows(ctx: Context, jobs: PublicJob[]): Promise<DirectorRow[]> {
  const look = await lookups(ctx, jobs.map((j) => j.createdBy), jobs.map((j) => j.productionId));
  return jobs.filter((j) => j.decider === "director").map((j) => {
    const card = j.takeId || j.nodeId ? look.card(j.productionId, j.takeId, j.nodeId) : null;
    return {
      id: j.id, production: look.production(j.productionId), step: j.stepId, at: j.createdAt, member: look.member(j.createdBy),
      product: j.product, status: j.status, engine: j.engine, settings: j.settings, inputs: j.inputs, prompt: j.prompt,
      quote: j.quote, actual: credits(ctx, j.actual?.credits), error: j.error && !REFUND.test(j.error) ? j.error : null,
      card, link: card?.href ?? null,
    };
  });
}

async function directorPage(ctx: Context, after: PageMark | null, limit: number): Promise<HistoryPage<DirectorRow>> {
  const jobs = await ctx.store.list({ ...ctx.base, decider: "director", ...(after ? { after } : {}), limit: limit + 1 });
  const shown = jobs.slice(0, limit);
  const next = jobs.length > limit ? encodeHistoryCursor({ at: shown[shown.length - 1].createdAt, id: shown[shown.length - 1].id }) : null;
  return { view: "director", unit: ctx.credits ? "credits" : null, rows: await directorRows(ctx, shown), next };
}

export async function directorHistory(q: HistoryQuery, viewer: HistoryViewer): Promise<HistoryPage<DirectorRow>> {
  return directorPage(await context(q, viewer), q.after, q.limit);
}

/* ── Aggregates ───────────────────────────────────────────────────────── */

const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

export async function historyAggregates(q: HistoryQuery, viewer: HistoryViewer): Promise<HistoryAggregates & { unit: "credits" | null }> {
  return aggregatesOf(await context(q, viewer));
}

async function aggregatesOf(ctx: Context): Promise<HistoryAggregates & { unit: "credits" | null }> {
  const [jobs, earlier] = await Promise.all([everyJob(ctx.store, ctx.base), everyEarlier(ctx)]);
  if (jobs.length + earlier.length > HISTORY_MAX_ROWS) throw new HistoryError("Too much History for one read. Ask for one month at a time.", 413);
  const items = [
    ...jobs.map((j) => ({ production: j.productionId, earlier: false, by: j.createdBy, at: j.createdAt, credits: j.actual?.credits ?? 0 })),
    ...earlier.map((r) => ({ production: r.productionId, earlier: true, by: r.createdBy, at: r.at, credits: r.credits ?? 0 })),
  ];
  const look = await lookups(ctx, items.map((i) => i.by), items.map((i) => i.production));
  const amount = (n: number) => (ctx.credits ? Math.round(n * 10) / 10 : null);
  const group = <K extends string>(key: (i: (typeof items)[number]) => K) => {
    const out = new Map<K, { jobs: number; sum: number; first: (typeof items)[number] }>();
    for (const i of items) {
      const k = key(i);
      const g = out.get(k);
      if (g) { g.jobs += 1; g.sum += i.credits; } else out.set(k, { jobs: 1, sum: i.credits, first: i });
    }
    return [...out.entries()];
  };
  const bigger = (a: HistoryAggregate, b: HistoryAggregate) => (b.credits ?? 0) - (a.credits ?? 0) || b.jobs - a.jobs;
  return {
    unit: ctx.credits ? "credits" : null,
    total: { jobs: items.length, credits: amount(items.reduce((s, i) => s + i.credits, 0)) },
    byProduction: group((i) => (i.production ? `p:${i.production}` : i.earlier ? "earlier" : "none"))
      .map(([, g]) => ({ production: look.production(g.first.production, g.first.earlier), jobs: g.jobs, credits: amount(g.sum) }))
      .sort(bigger),
    /* A member reads their own row by name and the rest of the team as one "Teammate" row (lib/usageLedger.ts). */
    byMember: group((i) => {
      const m = look.member(i.by);
      return m.id ? `m:${m.id}` : m.name === TEAMMATE ? "teammate" : "none";
    }).map(([, g]) => ({ member: look.member(g.first.by), jobs: g.jobs, credits: amount(g.sum) })).sort(bigger),
    byMonth: group((i) => monthOf(i.at)).map(([month, g]) => ({ month, jobs: g.jobs, credits: amount(g.sum) })).sort((a, b) => (a.month < b.month ? 1 : -1)),
  };
}

/* ── CSV ──────────────────────────────────────────────────────────────── */

const date = (at: number) => new Date(at).toISOString();
const who = (m: HistoryMember) => m.name ?? m.id ?? "";
const line = (cells: (string | number | null | undefined)[]) => cells.map((c) => csvCell(c)).join(",");

/** Agent rows: no engine column, and nothing in one. Earlier work says "before History" for what was never recorded. */
export const AGENT_CSV_HEADER = ["row", "source", "instruction", "production", "production_name", "step", "date_utc", "member", "state", "quote_credits", "credits", "cards", "link"] as const;

export function agentCsv(rows: AgentRow[]): string {
  const lines = [AGENT_CSV_HEADER.join(",")];
  for (const r of rows) {
    const earlier = r.source === "earlier";
    lines.push(line([
      r.id, r.source, r.instruction ?? "", r.production.id ?? (earlier ? BEFORE_HISTORY : ""), r.production.name ?? "", r.step ?? "", date(r.at), who(r.member),
      r.state, r.quote ? r.quote.credits : earlier ? BEFORE_HISTORY : "", r.total ? r.total.credits : "",
      r.cards.map((c) => (c.takeId ? `take:${c.takeId}` : c.nodeId ? `card:${c.nodeId}` : "")).filter(Boolean).join(" "), r.link ?? "",
    ]));
  }
  return lines.join("\r\n") + "\r\n";
}

export const DIRECTOR_CSV_HEADER = ["job", "production", "production_name", "step", "date_utc", "member", "product", "status", "engine", "engine_id", "settings", "inputs", "prompt", "quote_credits", "credits", "card", "link"] as const;

export function directorCsv(rows: DirectorRow[]): string {
  const lines = [DIRECTOR_CSV_HEADER.join(",")];
  for (const r of rows) {
    const settings = r.settings ? Object.entries(r.settings).map(([k, v]) => `${k}=${v}`).join("; ") : "";
    const inputs = r.inputs ? [...r.inputs.ports, ...r.inputs.cast.map((c) => `@${c}`)].join(" ") : "";
    lines.push(line([
      r.id, r.production.id ?? "", r.production.name ?? "", r.step ?? "", date(r.at), who(r.member), r.product, r.status,
      r.engine?.label ?? "", r.engine?.id ?? "", settings, inputs, r.prompt ?? "", r.quote ? r.quote.credits : "", r.actual ? r.actual.credits : "",
      r.card?.takeId ? `take:${r.card.takeId}` : r.card?.nodeId ? `card:${r.card.nodeId}` : "", r.link ?? "",
    ]));
  }
  return lines.join("\r\n") + "\r\n";
}

export const AGGREGATE_CSV_HEADER = ["group", "key", "name", "jobs", "credits"] as const;

export function aggregatesCsv(a: HistoryAggregates): string {
  const lines = [AGGREGATE_CSV_HEADER.join(",")];
  const amount = (g: HistoryAggregate) => (g.credits === null ? "" : g.credits);
  lines.push(line(["total", "", "", a.total.jobs, amount(a.total)]));
  for (const g of a.byProduction) lines.push(line(["production", g.production.id ?? "", g.production.name ?? "", g.jobs, amount(g)]));
  for (const g of a.byMember) lines.push(line(["member", g.member.id ?? "", who(g.member), g.jobs, amount(g)]));
  for (const g of a.byMonth) lines.push(line(["month", g.month, g.month, g.jobs, amount(g)]));
  return lines.join("\r\n") + "\r\n";
}

/** Every row of a view, for a file: page by page under one context, refused past HISTORY_MAX_ROWS. */
async function everyRow<R>(ctx: Context, read: (ctx: Context, after: PageMark | null, limit: number) => Promise<HistoryPage<R>>): Promise<R[]> {
  const rows: R[] = [];
  let after: PageMark | null = null;
  for (;;) {
    const page = await read(ctx, after, CSV_PAGE);
    rows.push(...page.rows);
    if (rows.length > HISTORY_MAX_ROWS) throw new HistoryError("Too much History for one file. Export one month at a time.", 413);
    if (!page.next) return rows;
    after = decodeHistoryCursor(page.next);
  }
}

/* ── the response ─────────────────────────────────────────────────────── */

const headers = { "Cache-Control": "private, no-store" };

/** GET /api/history: the read model the query names, as JSON or a CSV file. */
export async function historyResponse(req: Request, viewer: HistoryViewer): Promise<Response> {
  /* Off: the same 404 for every query, before the query is even read. */
  if (!(await historyOn(requireTenant()))) return Response.json({ error: "Not found." }, { status: 404, headers });
  const q = parseHistoryQuery(new URL(req.url).searchParams);
  if ("error" in q) return Response.json({ error: q.error }, { status: 400, headers });
  try {
    if (!q.csv) {
      const body = q.view === "agent" ? await agentHistory(q, viewer) : q.view === "director" ? await directorHistory(q, viewer) : await historyAggregates(q, viewer);
      return Response.json(body, { headers });
    }
    const ctx = await context(q, viewer);
    const text = q.view === "agent" ? agentCsv(await everyRow(ctx, agentPage))
      : q.view === "director" ? directorCsv(await everyRow(ctx, directorPage))
      : aggregatesCsv(await aggregatesOf(ctx));
    const name = `history-${q.view}-${requireTenant().slug}-${q.month ?? "all"}.csv`;
    return new Response(text, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` } });
  } catch (error) {
    if (error instanceof HistoryOffError || error instanceof JobsOffError) return Response.json({ error: "Not found." }, { status: 404, headers });
    if (error instanceof HistoryError || error instanceof TeamCanvasError || error instanceof QuotedJobError)
      return Response.json({ error: error.message }, { status: error.status, headers });
    throw error;
  }
}
