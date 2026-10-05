import { db, ready } from "@/lib/db";
import { platformDb, platformReady } from "@/lib/platform";
import { currentTenant } from "@/lib/tenant";
import { creditsApply, creditState } from "@/lib/credits";
import { getSetting } from "@/lib/settings";
import { cleanRule, cleanShotCap } from "@/lib/approvalRule";
import { billCredits, marginKeyOf } from "@/lib/creditTerms";
import { FREE, exact, shortBy as shortOf, upTo } from "@/lib/shell/price-words";
import { listGenerations, type Generation } from "@/lib/jobs";
import { heldNeeds, mayRelease } from "@/lib/workspace/release";
import { nameFor, type LedgerViewer } from "@/lib/usageLedger";
import { threadTitle } from "@/lib/atomikThreadsText";
import { runCharges } from "@/lib/generationRequests";
import { getRun, rigAgentExists, stepsOf, type RunRow } from "@/lib/workbench/rig-agent-store";
import { RIG_AGENT_OFF, rigAgentEnabled, runView, type RunLedger } from "@/lib/workbench/rig-agent";
import { rigJobCeiling } from "@/lib/workbench/rig-agent-limits";
import { stepTitle } from "@/lib/workbench/rig-agent-runs";
import type { RigAgentPaidStepView } from "@/lib/workbench/rig-agent-plan";
import {
  sortQueue,
  type ApprovalsReply, type DecidedItem, type QueueItem, type QueuePrice, type QueueProject,
} from "./queue";

/**
 * GET /api/control-room/approvals: everything in this workspace that waits for
 * a person, as one queue (lib/control-room/queue.ts), and the decisions of the
 * last days.
 *
 * Read-only. It reads this workspace's own database and, for what a decision
 * settled at, the platform meter filtered to this workspace; it writes
 * nothing, never wakes a run and never contacts a provider. Money is in
 * credits only: no vendor cost, and no dollar figure of any kind, leaves this
 * path. A workspace that is not billed in credits gets no figures at all.
 *
 * Who may press what is the code's own rule for each record, never a looser
 * one: a held take is released by its maker or an admin (lib/workspace/
 * release.ts), a board's build and renders by the person who asked
 * (lib/workbench/rig-agent.ts), a plan's step by any member at its live price.
 * On top of that, with the workspace's per-shot rule on, a member never gets
 * Approve on an item priced above the cap (an admin presses it).
 */

type Row = Record<string, unknown>;
export type ApprovalsViewer = { id: string; role: string; owner?: boolean };

/** Decisions shown: the last week, at most this many. */
export const DECIDED_DAYS = 7;
export const DECIDED_LIMIT = 10;
/** Each source reads at most this many waiting records. */
const SOURCE_LIMIT = 100;

/* The code's own words, so every screen says what the route would say. */
const RELEASE_NOT_YOURS = "Only the person who made this take, or an admin, can release it.";
const BOARD_NOT_YOURS = "Only the person who asked Atomik for this board can approve it.";
const RENDER_NOT_YOURS = "Only the person who asked Atomik for this run can approve its renders.";
/** What a take held for credits is waiting for (lib/held.ts: released as soon as credits arrive). */
export const HELD_NOTE = "It starts when credits arrive; nothing is spent until then";

export const text = (value: unknown) => (value == null || value === "" ? null : String(value));
export const shortText = (value: string, max = 60) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** The per-shot rule as the workspace set it (lib/approvalRule.ts): the cap in credits when the rule is `cap`, else null. */
async function shotCap(): Promise<number | null> {
  const [rule, cap] = await Promise.all([getSetting("approvalRule").catch(() => "anyone"), getSetting("shotCapCredits").catch(() => "50")]);
  return cleanRule(rule) === "cap" ? cleanShotCap(cap) : null;
}

/** The rule's own sentence for a member over the cap. */
const capWords = (cap: number) => `Members up to ${cap.toLocaleString("en-US")} cr a shot; an admin above it`;

/** Production names, and this viewer's own draft of each production (the project Home's cards show). */
export async function projectsOf(viewer: string, productions: string[]): Promise<Map<string, QueueProject>> {
  const ids = [...new Set(productions.filter(Boolean))];
  const out = new Map<string, QueueProject>();
  if (!ids.length) return out;
  const marks = ids.map(() => "?").join(",");
  const [names, drafts] = await Promise.all([
    db().execute({ sql: `SELECT id, name FROM projects WHERE id IN (${marks})`, args: ids }).catch(() => ({ rows: [] as Row[] })),
    /* As the jobs tray finds them (lib/jobsTray.server.ts): this person's newest draft open on that production. */
    db().execute({
      sql: `SELECT project_id, json_extract(body,'$.productionProjectId') AS production FROM workbench_projects
            WHERE owner=? AND json_extract(body,'$.productionProjectId') IN (${marks}) ORDER BY updated_at DESC`,
      args: [viewer, ...ids],
    }).catch(() => ({ rows: [] as Row[] })),
  ]);
  const name = new Map((names.rows as Row[]).map((r) => [String(r.id), String(r.name)]));
  const draft = new Map<string, string>();
  for (const r of drafts.rows as Row[]) {
    const production = String(r.production ?? "");
    if (production && !draft.has(production)) draft.set(production, String(r.project_id));
  }
  for (const id of ids) out.set(id, { productionId: id, draftId: draft.get(id) ?? null, name: name.get(id) ?? null });
  return out;
}

export const NO_PROJECT: QueueProject = { productionId: null, draftId: null, name: null };

/** Approve, unless the rule puts the price over the cap for this viewer. */
function capGate(credits: number | null, cap: number | null, admin: boolean): { needsAdmin: boolean; why: string | null } {
  const needsAdmin = cap !== null && credits !== null && credits > cap;
  return { needsAdmin, why: needsAdmin && !admin ? capWords(cap!) : null };
}

/* ── Held takes (lib/held.ts) ──────────────────────────────────────────── */

async function heldItems(viewer: ApprovalsViewer, ctx: Ctx): Promise<{ items: QueueItem[]; productions: string[] }> {
  const rows = await listGenerations({ status: "held", limit: SOURCE_LIMIT });
  /* Held for a slot is a place in the line and starts on its own; held for credits waits for a person. */
  const waiting = rows.filter((g) => (g.params?.held as { why?: unknown } | undefined)?.why === "credits");
  const items = waiting.map((g): QueueItem => {
    const needs = ctx.inCredits ? heldNeeds(g.params) : null;
    /* No figure where the workspace is not billed in credits, or none was kept. */
    const price: QueuePrice = ctx.inCredits ? exact(needs) : null;
    const mine = mayRelease({ id: viewer.id, role: viewer.owner ? "owner" : viewer.role }, g.createdBy);
    const gate = capGate(needs, ctx.cap, ctx.admin);
    const shortBy = shortOf(ctx.balance, price);
    return {
      id: `held:${g.id}`,
      source: "held",
      title: shortText((g.title ?? "").trim() || g.prompt || "") || "Untitled take",
      where: g.shotCode ? "Board" : "Make",
      at: g.createdAt,
      project: NO_PROJECT,
      price,
      needsAdmin: gate.needsAdmin,
      /* Release refuses while the balance is short (lib/held.ts), so a short take waits with Top up instead. */
      canApprove: mine && !gate.why && !shortBy && needs !== null,
      why: !mine ? RELEASE_NOT_YOURS : gate.why,
      shortBy,
      note: HELD_NOTE,
      step: null,
      sample: isDemoTake(g),
      approve: needs !== null ? { kind: "release", genId: g.id, credits: needs } : null,
      decline: mine ? { kind: "discard", genId: g.id } : null,
      open: { kind: "take", genId: g.id, draftId: null },
    };
  });
  return { items, productions: waiting.map((g) => g.projectId ?? "") };
}

/** The starter production's demo takes (lib/jobs.ts `ownRenders`): explore-only, never spent on. */
const isDemoTake = (g: Pick<Generation, "params">) => Boolean((g.params as { demo?: unknown } | undefined)?.demo);

/* ── Atomik on a board (lib/workbench/rig-agent*.ts) ───────────────────── */

export async function ledgerOf(run: RunRow): Promise<RunLedger> {
  const [charges, ceiling] = await Promise.all([
    run.capCredits == null ? Promise.resolve([]) : runCharges(run.id).catch(() => []),
    rigJobCeiling().catch(() => null),
  ]);
  return { charges, ceiling };
}

/** A render's price as the run card holds it: its quote, or up to the most it may settle at when that is higher. */
export function renderPrice(step: RigAgentPaidStepView, inCredits: boolean): QueuePrice {
  if (!inCredits || step.quote == null) return null;
  return step.worst != null && step.worst > step.quote ? upTo(step.worst) : exact(step.quote);
}

async function boardItems(viewer: ApprovalsViewer, ctx: Ctx): Promise<{ items: QueueItem[]; productions: string[] }> {
  if (!(await rigAgentExists())) return { items: [], productions: [] };
  const ids = (await db().execute({
    sql: "SELECT id FROM rig_agent_runs WHERE state IN ('awaiting_approval','needs_you') ORDER BY created_at LIMIT ?",
    args: [SOURCE_LIMIT],
  })).rows.map((r) => String((r as Row).id));
  const enabled = rigAgentEnabled();
  const items: QueueItem[] = [];
  const productions: string[] = [];
  for (const id of ids) {
    const run = await getRun(db(), id);
    if (!run) continue;
    const view = runView(run, await stepsOf(db(), run.id), viewer.id, await ledgerOf(run));
    productions.push(run.productionId);
    const open = { kind: "board" as const, productionId: run.productionId, draftId: null };
    if (run.state === "awaiting_approval" && view.proposal) {
      const p = view.proposal;
      items.push({
        id: `board-plan:${run.id}`,
        source: "board-plan",
        title: shortText(p.title || run.goal) || "Atomik's board",
        where: "Board",
        at: run.updatedAt,
        project: NO_PROJECT,
        price: FREE,
        needsAdmin: false,
        canApprove: view.mine && enabled,
        why: !enabled ? RIG_AGENT_OFF : !view.mine ? BOARD_NOT_YOURS : null,
        shortBy: null,
        note: p.next.length ? p.next.join(" · ") : null,
        step: null,
        sample: false,
        approve: { kind: "board-approve", productionId: run.productionId, runId: run.id, fingerprint: p.fingerprint },
        decline: view.mine ? { kind: "board-decline", productionId: run.productionId, runId: run.id } : null,
        open,
      });
      continue;
    }
    for (const step of view.paid) {
      if (step.tool !== "render" || (step.state !== "waiting" && step.state !== "paused")) continue;
      const price = renderPrice(step, ctx.inCredits);
      const credits = price && price.kind !== "free" ? price.credits : null;
      const gate = capGate(credits, ctx.cap, ctx.admin);
      const waiting = step.state === "waiting";
      const tappable = waiting && step.canRender && enabled && !!step.fingerprint;
      const shortBy = shortOf(ctx.balance, price);
      items.push({
        id: `board-render:${run.id}:${step.seq}`,
        source: "board-render",
        title: shortText(step.title) || "A render",
        where: "Board",
        at: run.updatedAt,
        project: NO_PROJECT,
        price,
        needsAdmin: gate.needsAdmin || step.pause === "admin",
        canApprove: tappable && !gate.why,
        why: !enabled ? RIG_AGENT_OFF
          : !view.mine ? RENDER_NOT_YOURS
          : gate.why
          /* A paused render is retried, priced again or unlocked on its board, in the run card's own words. */
          ?? (waiting ? null : step.reason ?? "It waits on its board."),
        shortBy,
        note: run.goal ? shortText(run.goal, 90) : null,
        step: null,
        sample: false,
        approve: waiting && step.fingerprint ? { kind: "board-render", productionId: run.productionId, runId: run.id, seq: step.seq, fingerprint: step.fingerprint } : null,
        decline: view.mine ? { kind: "board-skip", productionId: run.productionId, runId: run.id, seq: step.seq } : null,
        open,
      });
    }
  }
  return { items, productions };
}

/* ── A step of an Atomik plan (lib/atomik.ts) ──────────────────────────── */

async function threadItems(_viewer: ApprovalsViewer, ctx: Ctx): Promise<{ items: QueueItem[]; productions: string[] }> {
  /* The checkpoint, as the plan shows it (components/atomik/AtomikProvider.tsx): the first proposed step, by
     position, of the chat's last answer; never a step planned on the connected account, never in a chat that
     is still planning, archived or removed. */
  const rs = await db().execute({
    sql: `WITH last AS (
            SELECT m.chat_id, m.id AS message_id FROM atomik_messages m
            WHERE m.role = 'assistant' AND m.created_at = (SELECT MAX(x.created_at) FROM atomik_messages x WHERE x.chat_id = m.chat_id AND x.role = 'assistant')
          )
          SELECT s.id, s.chat_id, s.position, s.kind, s.title, s.model, s.est_cost_usd, s.created_at,
                 c.project_id, c.title AS chat_title,
                 (SELECT u.text FROM atomik_messages u WHERE u.chat_id = c.id AND u.role = 'user' ORDER BY u.created_at ASC, u.rowid ASC LIMIT 1) AS first_ask,
                 (SELECT COUNT(*) FROM atomik_steps t WHERE t.chat_id = s.chat_id AND t.message_id = s.message_id AND t.status <> 'rejected') AS plan_steps,
                 (SELECT COUNT(*) FROM atomik_steps t WHERE t.chat_id = s.chat_id AND t.message_id = s.message_id AND t.status <> 'rejected'
                    AND (t.position < s.position OR (t.position = s.position AND t.id < s.id))) AS before
          FROM atomik_steps s
          JOIN atomik_chats c ON c.id = s.chat_id
          JOIN last l ON l.chat_id = s.chat_id AND l.message_id = s.message_id
          WHERE s.status = 'proposed' AND s.model NOT LIKE 'connected:%'
            AND c.deleted = 0 AND c.archived_at IS NULL AND c.status <> 'running'
          ORDER BY s.chat_id, s.position, s.id`,
    args: [],
  }).catch((error: unknown) => {
    /* A workspace that never used Atomik has no plan tables yet. */
    if (/no such table/i.test(String(error))) return { rows: [] as Row[] };
    throw error;
  });
  const first = new Map<string, Row>();
  for (const r of rs.rows as Row[]) if (!first.has(String(r.chat_id))) first.set(String(r.chat_id), r);
  const items = [...first.values()].slice(0, SOURCE_LIMIT).map((r): QueueItem => {
    const est = r.est_cost_usd == null ? null : Number(r.est_cost_usd);
    /* Continue sends its live quote as the ceiling, so what a person approves is never passed: "up to". */
    const credits = ctx.inCredits && est !== null && Number.isFinite(est) ? billCredits(est, marginKeyOf(text(r.kind), text(r.model))) : null;
    const price: QueuePrice = upTo(credits);
    const gate = capGate(credits, ctx.cap, ctx.admin);
    const n = Number(r.before ?? 0) + 1, of = Math.max(n, Number(r.plan_steps ?? 1));
    const title = text(r.title) ?? "The next step";
    const shortBy = shortOf(ctx.balance, price);
    const productionId = text(r.project_id);
    return {
      id: `thread:${String(r.chat_id)}`,
      source: "thread",
      title: threadTitle(String(r.chat_title ?? ""), text(r.first_ask)),
      where: "Atomik",
      at: Number(r.created_at ?? 0),
      project: NO_PROJECT,
      price,
      needsAdmin: gate.needsAdmin,
      /* Any member continues a plan; Continue prices the step live before anything is sent. */
      canApprove: !gate.why,
      why: gate.why,
      shortBy,
      note: `Step ${n} of ${of} · ${shortText(title, 80)}`,
      step: { n, of },
      sample: false,
      approve: { kind: "thread", chatId: String(r.chat_id), stepId: String(r.id), productionId },
      decline: { kind: "thread-stop", stepId: String(r.id) },
      open: { kind: "thread", chatId: String(r.chat_id), productionId },
    };
  });
  return { items, productions: [...first.values()].map((r) => text(r.project_id) ?? "") };
}

/* ── What was decided ──────────────────────────────────────────────────── */

export type MeterRow = { status: string; credits: number };

/** What the meter holds for these jobs in this workspace: status and the credits charged. */
export async function meterOf(workspaceId: string, ids: string[]): Promise<Map<string, MeterRow>> {
  const out = new Map<string, MeterRow>();
  if (!ids.length) return out;
  await platformReady();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rs = await platformDb().execute({
      sql: `SELECT id, status, CASE WHEN paid_by_platform=1 THEN COALESCE(billed_credits,0) ELSE 0 END AS credits
            FROM meter_events WHERE workspace_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
      args: [workspaceId, ...chunk],
    });
    for (const r of rs.rows as Row[]) out.set(String(r.id), { status: String(r.status), credits: Number(r.credits ?? 0) });
  }
  return out;
}

/** A sent job's outcome from the meter: settled at a figure, still settling, or confirmed as nothing charged. */
export function outcomeOf(id: string | null, meter: Map<string, MeterRow>, inCredits: boolean): DecidedItem["outcome"] {
  if (!inCredits) return { kind: "unbilled" };
  const row = id ? meter.get(id) : undefined;
  if (!row) return { kind: "unknown" };
  if (row.status === "running") return { kind: "settling" };
  return row.credits > 0 ? { kind: "settled", credits: row.credits } : { kind: "nothing" };
}

/** A decision as read, before names, outcomes and projects are attached. */
type Found = {
  id: string; title: string; what: string; at: number;
  /** The job it sent, whose meter row says what it settled at. */
  job: string | null;
  /** Who decided: a user id, or null when the record does not say (or Auto decided). */
  author: string | null;
  production: string | null;
  /** Something paid was sent. Otherwise nothing was charged: turned down, skipped, set aside, or a free build. */
  sent: boolean;
};

export const missingTable = (error: unknown) => /no such table/i.test(String(error));

async function boardDecisions(since: number): Promise<Found[]> {
  if (!(await rigAgentExists())) return [];
  const found: Found[] = [];
  /* Renders approved (by a person, or by Auto under the per-job line) or skipped. */
  const steps = (await db().execute({
    sql: `SELECT run_id, seq, node_id, label, state, approved_by, approved_at, job_id, updated_at FROM rig_agent_steps
          WHERE purpose = 'take' AND ((approved_at IS NOT NULL AND approved_at >= ?) OR (state = 'skipped' AND approved_at IS NULL AND updated_at >= ? AND reason LIKE 'Skipped%'))
          ORDER BY COALESCE(approved_at, updated_at) DESC LIMIT ?`,
    args: [since, since, DECIDED_LIMIT],
  })).rows as Row[];
  const runs = new Map<string, RunRow | null>();
  for (const s of steps) {
    const runId = String(s.run_id);
    if (!runs.has(runId)) runs.set(runId, await getRun(db(), runId));
    const run = runs.get(runId);
    if (!run) continue;
    const skipped = s.approved_at == null;
    const by = text(s.approved_by);
    found.push({
      id: `board-render:${runId}:${String(s.seq)}`,
      title: shortText(stepTitle(run, { nodeId: text(s.node_id), label: String(s.label ?? "") }) || run.goal) || "A render",
      what: skipped ? "skipped" : by === "auto" ? "spent without asking" : "approved",
      at: Number(skipped ? s.updated_at : s.approved_at),
      job: text(s.job_id),
      /* Only the person who asked skips a render; Auto has no name. */
      author: skipped ? run.owner : by === "auto" ? null : by,
      production: run.productionId,
      sent: !skipped && s.job_id != null,
    });
  }
  /* Builds approved or set aside: free either way. */
  const builds = (await db().execute({
    sql: `SELECT id, approved_by, approved_at, finished_at, owner, production_id, goal, plan FROM rig_agent_runs
          WHERE (approved_at IS NOT NULL AND approved_at >= ?) OR (state = 'stopped' AND reason = 'Not built: set aside.' AND finished_at >= ?)
          ORDER BY COALESCE(approved_at, finished_at) DESC LIMIT ?`,
    args: [since, since, DECIDED_LIMIT],
  })).rows as Row[];
  for (const b of builds) {
    const setAside = b.approved_at == null;
    let title = String(b.goal ?? "");
    try { title = (JSON.parse(String(b.plan ?? "null")) as { title?: string } | null)?.title || title; } catch { /* the goal stands */ }
    found.push({
      id: `board-plan:${String(b.id)}`, title: shortText(title) || "Atomik's board",
      what: setAside ? "set aside" : "approved", at: Number(setAside ? b.finished_at : b.approved_at),
      job: null, author: setAside ? text(b.owner) : text(b.approved_by), production: text(b.production_id), sent: false,
    });
  }
  return found;
}

async function planDecisions(since: number): Promise<Found[]> {
  /* A step continued (claimed by a person, then sent) or turned down. */
  const steps = (await db().execute({
    sql: `SELECT s.id, s.title, s.status, s.gen_id, s.claimed_by, s.updated_at, c.project_id FROM atomik_steps s
          JOIN atomik_chats c ON c.id = s.chat_id
          WHERE s.status IN ('done','failed','rejected') AND s.updated_at >= ? AND s.model NOT LIKE 'connected:%' AND c.deleted = 0
          ORDER BY s.updated_at DESC LIMIT ?`,
    args: [since, DECIDED_LIMIT],
  }).catch((error: unknown) => {
    if (missingTable(error)) return { rows: [] as Row[] };
    throw error;
  })).rows as Row[];
  return steps.map((s) => {
    const rejected = s.status === "rejected";
    return {
      id: `thread-step:${String(s.id)}`, title: shortText(String(s.title ?? "")) || "A step",
      what: rejected ? "turned down" : "approved", at: Number(s.updated_at),
      job: text(s.gen_id), author: rejected ? null : text(s.claimed_by), production: text(s.project_id),
      sent: !rejected && s.gen_id != null,
    };
  });
}

async function releaseDecisions(since: number): Promise<Found[]> {
  /* Held takes released by a press, or by credits arriving: the record does not say which, so no name. */
  const rows = (await db().execute({
    sql: `SELECT id, title, prompt, project_id, json_extract(params,'$.releasedAt') AS released_at FROM generations
          WHERE json_valid(params) AND json_extract(params,'$.releasedAt') >= ? ORDER BY released_at DESC LIMIT ?`,
    args: [since, DECIDED_LIMIT],
  })).rows as Row[];
  return rows.map((g) => ({
    id: `held:${String(g.id)}`, title: shortText(String(g.title ?? "").trim() || String(g.prompt ?? "")) || "Untitled take",
    what: "released", at: Number(g.released_at), job: String(g.id), author: null, production: text(g.project_id), sent: true,
  }));
}

async function decidedItems(viewer: ApprovalsViewer, ctx: Ctx, since: number): Promise<(DecidedItem & { production: string | null })[]> {
  const found = (await Promise.all([boardDecisions(since), planDecisions(since), releaseDecisions(since)])).flat();
  const recent = found.filter((f) => Number.isFinite(f.at)).sort((a, b) => b.at - a.at).slice(0, DECIDED_LIMIT);
  const meter = await meterOf(ctx.workspaceId, recent.map((f) => f.job).filter((id): id is string => !!id)).catch(() => new Map<string, MeterRow>());
  const authors = [...new Set(recent.map((f) => f.author).filter((a): a is string => !!a))];
  const names = new Map<string, string>();
  if (authors.length) {
    const rs = await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${authors.map(() => "?").join(",")})`, args: authors }).catch(() => ({ rows: [] as Row[] }));
    for (const r of rs.rows as Row[]) names.set(String(r.id), String(r.name));
  }
  /* Names follow the usage ledger (lib/usageLedger.ts): admins read names; a member reads their own and "Teammate". */
  const ledgerViewer: LedgerViewer = { id: viewer.id, admin: ctx.admin };
  return recent.map((f) => ({
    id: f.id, title: f.title, what: f.what, at: f.at, project: NO_PROJECT, production: f.production,
    by: f.author ? nameFor(ledgerViewer, f.author, names) : null,
    byYou: f.author === viewer.id,
    outcome: !ctx.inCredits ? { kind: "unbilled" } : f.sent ? outcomeOf(f.job, meter, ctx.inCredits) : { kind: "nothing" },
  }));
}

/* ── The read ──────────────────────────────────────────────────────────── */

type Ctx = { workspaceId: string; inCredits: boolean; admin: boolean; cap: number | null; balance: number | null };

/** Everything waiting for a person in this workspace, as this viewer may act on it, and the last decisions. */
export async function readApprovals(viewer: ApprovalsViewer, now = Date.now()): Promise<ApprovalsReply> {
  await ready();
  const workspace = currentTenant()?.workspace;
  if (!workspace) throw new Error("No workspace.");
  const inCredits = creditsApply(workspace);
  const [cap, state] = await Promise.all([shotCap(), inCredits ? creditState().catch(() => null) : Promise.resolve(null)]);
  const ctx: Ctx = {
    workspaceId: workspace.id, inCredits, cap, balance: state ? state.balance : null,
    admin: viewer.owner === true || viewer.role === "admin" || viewer.role === "owner",
  };
  const [held, board, threads, decided] = await Promise.all([
    heldItems(viewer, ctx),
    boardItems(viewer, ctx),
    threadItems(viewer, ctx),
    decidedItems(viewer, ctx, now - DECIDED_DAYS * 86_400_000),
  ]);
  const projects = await projectsOf(viewer.id, [...held.productions, ...board.productions, ...threads.productions, ...decided.map((d) => d.production ?? "")]);
  const projectOf = (production: string | null | undefined): QueueProject =>
    production ? projects.get(production) ?? { productionId: production, draftId: null, name: null } : NO_PROJECT;
  const placed = (item: QueueItem, production: string | null | undefined): QueueItem => {
    const project = projectOf(production);
    const open = item.open.kind === "take" || item.open.kind === "board" ? { ...item.open, draftId: project.draftId } : item.open;
    return { ...item, project, open };
  };
  const items = [
    ...held.items.map((item, i) => placed(item, held.productions[i])),
    ...board.items.map((item) => placed(item, item.open.kind === "board" ? item.open.productionId : null)),
    ...threads.items.map((item, i) => placed(item, threads.productions[i])),
  ];
  return {
    items: sortQueue(items),
    decided: decided.map(({ production, ...item }) => ({ ...item, project: projectOf(production) })),
    inCredits,
  };
}
