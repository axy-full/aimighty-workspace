import { db, ready } from "@/lib/db";
import { platformDb, platformReady } from "@/lib/platform";
import { currentTenant } from "@/lib/tenant";
import { creditsApply } from "@/lib/credits";
import { billCredits, marginKeyOf } from "@/lib/creditTerms";
import { upTo } from "@/lib/shell/price-words";
import { nameFor, type LedgerViewer } from "@/lib/usageLedger";
import { threadTitle } from "@/lib/atomikThreadsText";
import { getRun, rigAgentExists, stepsOf, type RunRow } from "@/lib/workbench/rig-agent-store";
import { runView } from "@/lib/workbench/rig-agent";
import type { RigAgentState } from "@/lib/workbench/rig-agent-plan";
import {
  NO_PROJECT, ledgerOf, meterOf, missingTable, outcomeOf, projectsOf, renderPrice, shortText, text,
  type ApprovalsViewer, type MeterRow,
} from "./approvals.server";
import type { ActivityReply, ActivityRun, ProjectSpend, RunState, RunStep } from "./activity";
import type { Outcome, QueueProject } from "./queue";

/**
 * GET /api/control-room/activity: Atomik's runs on one production (or on
 * every one), each with its steps priced and settled, and what every project
 * has settled (lib/control-room/activity.ts).
 *
 * Read-only: this workspace's own database and, for settled figures, the
 * platform meter filtered to this workspace. It writes nothing, never wakes a
 * run and never contacts a provider. Credits only: no vendor cost, no dollar
 * figure, and nothing at all for a workspace not billed in credits. There is
 * no "held" figure: what is in flight reads as settling.
 */

type Row = Record<string, unknown>;

/** Runs read per production, newest first. */
export const RUNS_LIMIT = 50;

const SETTLED_STATUSES = ["succeeded", "failed"];

/** What each production has settled: the meter's finished rows, in credits, this workspace only. */
async function settledByProject(workspaceId: string): Promise<Map<string, number>> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: `SELECT project_id, SUM(CASE WHEN paid_by_platform=1 THEN COALESCE(billed_credits,0) ELSE 0 END) AS credits
          FROM meter_events WHERE workspace_id = ? AND project_id IS NOT NULL AND status IN (${SETTLED_STATUSES.map(() => "?").join(",")})
          GROUP BY project_id HAVING credits > 0`,
    args: [workspaceId, ...SETTLED_STATUSES],
  });
  return new Map((rs.rows as Row[]).map((r) => [String(r.project_id), Number(r.credits)]));
}

/** A step's figure folded into its run: settled credits add up; anything unsettled marks the run as settling. */
function fold(outcomes: Outcome[]): { settled: number; settling: boolean } {
  let settled = 0, settling = false;
  for (const o of outcomes) {
    if (o.kind === "settled") settled += o.credits;
    if (o.kind === "settling") settling = true;
  }
  return { settled: Math.round(settled * 10) / 10, settling };
}

type Names = { names: Map<string, string>; viewer: LedgerViewer };
const who = (author: string | null, n: Names) => (author ? nameFor(n.viewer, author, n.names) : null);

/* ── Threads: a request in Atomik's panel and the plans it made (lib/atomik.ts) ── */

async function threadRuns(production: string | null, inCredits: boolean, workspaceId: string): Promise<{ runs: Omit<ActivityRun, "n" | "project">[]; authors: string[]; productions: string[]; meter: Map<string, MeterRow> }> {
  const chats = (await db().execute({
    sql: `SELECT c.id, c.project_id, c.title, c.status, c.created_by, c.created_at,
                 (SELECT u.text FROM atomik_messages u WHERE u.chat_id = c.id AND u.role = 'user' ORDER BY u.created_at ASC, u.rowid ASC LIMIT 1) AS first_ask
          FROM atomik_chats c WHERE c.deleted = 0 ${production === null ? "" : "AND c.project_id IS ?"}
          ORDER BY c.created_at DESC LIMIT ?`,
    args: production === null ? [RUNS_LIMIT] : [production, RUNS_LIMIT],
  }).catch((error: unknown) => {
    if (missingTable(error)) return { rows: [] as Row[] };
    throw error;
  })).rows as Row[];
  if (!chats.length) return { runs: [], authors: [], productions: [], meter: new Map() };
  const ids = chats.map((c) => String(c.id));
  const marks = ids.map(() => "?").join(",");
  const [steps, turns] = await Promise.all([
    db().execute({
      sql: `SELECT id, chat_id, message_id, position, kind, title, model, status, est_cost_usd, gen_id, claimed_by, updated_at
            FROM atomik_steps WHERE chat_id IN (${marks}) AND model NOT LIKE 'connected:%' ORDER BY chat_id, created_at, position`,
      args: ids,
    }),
    /* Each answer's planning turn is metered under the answer's own id (lib/atomik.ts). */
    db().execute({ sql: `SELECT id, chat_id, created_at FROM atomik_messages WHERE chat_id IN (${marks}) AND role = 'assistant' ORDER BY created_at`, args: ids }),
  ]);
  const stepRows = steps.rows as Row[], turnRows = turns.rows as Row[];
  const meter = inCredits
    ? await meterOf(workspaceId, [...turnRows.map((t) => String(t.id)), ...stepRows.map((s) => text(s.gen_id)).filter((id): id is string => !!id)]).catch(() => new Map<string, MeterRow>())
    : new Map<string, MeterRow>();
  const authors: string[] = [];
  const runs = chats.map((c) => {
    const id = String(c.id);
    const mine = stepRows.filter((s) => String(s.chat_id) === id);
    const thinking: RunStep[] = turnRows.filter((t) => String(t.chat_id) === id && meter.has(String(t.id))).map((t) => ({
      id: `turn:${String(t.id)}`, kind: "thinking", title: "Atomik's thinking", priced: null,
      settled: outcomeOf(String(t.id), meter, inCredits), state: "done", by: null, byYou: false, auto: false, at: Number(t.created_at),
    }));
    const paid: RunStep[] = mine.map((s) => {
      const est = s.est_cost_usd == null ? null : Number(s.est_cost_usd);
      const status = String(s.status);
      const gen = text(s.gen_id);
      const sent = status === "done" || status === "failed" || status === "running";
      if (sent && s.claimed_by) authors.push(String(s.claimed_by));
      return {
        id: `step:${String(s.id)}`, kind: "paid", title: shortText(String(s.title ?? "")) || "A step",
        priced: inCredits && est !== null && Number.isFinite(est) ? upTo(billCredits(est, marginKeyOf(text(s.kind), text(s.model)))) : null,
        settled: !inCredits ? { kind: "unbilled" } : gen ? outcomeOf(gen, meter, inCredits) : status === "rejected" ? { kind: "nothing" } : { kind: "unknown" },
        state: status === "proposed" ? "waiting" : status === "rejected" ? "turned down" : status === "running" ? "running"
          : status === "failed" ? "failed" : gen && meter.get(gen)?.status === "running" ? "running" : "done",
        /* `claimed_by` is the person who pressed Continue; resolved to a name below. */
        by: sent ? text(s.claimed_by) : null, byYou: false, auto: false, at: Number(s.updated_at),
      };
    });
    const all = [...thinking, ...paid];
    const { settled, settling } = fold(all.map((s) => s.settled));
    const waiting = paid.some((s) => s.state === "waiting");
    const state: RunState = c.status === "running" ? "planning" : c.status === "failed" ? "failed"
      : waiting ? "needs-you" : paid.some((s) => s.state === "running") || settling ? "running" : "done";
    return {
      id: `thread:${id}`, source: "thread" as const,
      title: threadTitle(String(c.title ?? ""), text(c.first_ask)), startedAt: Number(c.created_at), state,
      reason: null, steps: all.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), settled, settling,
      request: text(c.first_ask) ?? "", open: { kind: "thread" as const, chatId: id, productionId: text(c.project_id) },
      _production: text(c.project_id),
    };
  });
  return { runs, authors, productions: runs.map((r) => r._production ?? ""), meter };
}

/* ── Board runs: Atomik building and rendering on a board (lib/workbench/rig-agent*.ts) ── */

const BOARD_STATE: Record<RigAgentState, RunState> = {
  planning: "planning", awaiting_approval: "needs-you", needs_you: "needs-you", running: "running", paused: "running",
  done: "done", stopped: "stopped", failed: "failed",
};

async function boardRuns(production: string | null, inCredits: boolean, viewerId: string): Promise<{ runs: (Omit<ActivityRun, "n" | "project"> & { _production: string })[]; authors: string[] }> {
  if (!(await rigAgentExists())) return { runs: [], authors: [] };
  const ids = ((await db().execute({
    sql: `SELECT id FROM rig_agent_runs ${production === null ? "" : "WHERE production_id = ?"} ORDER BY created_at DESC LIMIT ?`,
    args: production === null ? [RUNS_LIMIT] : [production, RUNS_LIMIT],
  })).rows as Row[]).map((r) => String(r.id));
  const authors: string[] = [];
  const runs: (Omit<ActivityRun, "n" | "project"> & { _production: string })[] = [];
  for (const id of ids) {
    const run: RunRow | null = await getRun(db(), id);
    if (!run) continue;
    const raw = await stepsOf(db(), run.id);
    const view = runView(run, raw, viewerId, await ledgerOf(run));
    const bySeq = new Map(raw.map((s) => [s.seq, s]));
    const steps: RunStep[] = [];
    const planning = view.money?.planning;
    if (planning) {
      steps.push({
        id: `plan:${run.id}`, kind: "thinking", title: "Atomik's thinking", priced: null,
        settled: !inCredits ? { kind: "unbilled" } : planning.state === "reserved" ? { kind: "settling" }
          /* Released: nothing was charged. Settled: the ledger's figure, or no figure when it holds none (never "nothing billed" by guess). */
          : planning.state === "released" ? { kind: "nothing" } : planning.credits == null ? { kind: "unknown" }
          : planning.credits > 0 ? { kind: "settled", credits: planning.credits } : { kind: "nothing" },
        state: planning.state === "reserved" ? "running" : "done", by: null, byYou: false, auto: false, at: run.planningStartedAt,
      });
    }
    for (const p of view.paid) {
      if (p.tool !== "render") continue;
      const row = bySeq.get(p.seq);
      const approver = row?.approvedBy ?? null;
      const auto = approver === "auto";
      if (approver && !auto) authors.push(approver);
      const ended = p.state === "done" || p.state === "failed";
      const settled: Outcome = !inCredits ? { kind: "unbilled" }
        : p.state === "skipped" ? { kind: "nothing" }
        : ended ? (p.charged != null ? (p.charged > 0 ? { kind: "settled", credits: p.charged } : { kind: "nothing" }) : p.outcome === "not_billed" ? { kind: "nothing" } : { kind: "unknown" })
        : p.state === "sending" || p.state === "rendering" || p.state === "approved" ? { kind: "settling" } : { kind: "unknown" };
      steps.push({
        id: `render:${run.id}:${p.seq}`, kind: "paid", title: shortText(p.title) || "A render", priced: renderPrice(p, inCredits), settled,
        state: p.state === "waiting" || p.state === "paused" || p.state === "next" ? "waiting" : p.state === "skipped" ? "skipped"
          : p.state === "failed" ? "failed" : p.state === "done" ? "done" : p.state === "approved" ? "approved" : "running",
        by: auto ? null : approver, byYou: false, auto, at: row?.approvedAt ?? row?.settledAt ?? null,
      });
    }
    const { settled, settling } = fold(steps.map((s) => s.settled));
    runs.push({
      id: `board:${run.id}`, source: "board", title: shortText(view.proposal?.title || run.goal) || "Atomik's board",
      startedAt: run.createdAt, state: BOARD_STATE[run.state] ?? "running", reason: run.reason, steps, settled, settling,
      request: run.goal, open: { kind: "board", productionId: run.productionId, draftId: null }, _production: run.productionId,
    });
  }
  return { runs, authors };
}

/* ── The read ──────────────────────────────────────────────────────────── */

/** Runs on one production (null: every one), each priced and settled, and what each project has settled. */
export async function readActivity(viewer: ApprovalsViewer, production: string | null): Promise<ActivityReply> {
  await ready();
  const workspace = currentTenant()?.workspace;
  if (!workspace) throw new Error("No workspace.");
  const inCredits = creditsApply(workspace);
  const admin = viewer.owner === true || viewer.role === "admin" || viewer.role === "owner";
  const [threads, boards, spend] = await Promise.all([
    threadRuns(production, inCredits, workspace.id),
    boardRuns(production, inCredits, viewer.id),
    inCredits ? settledByProject(workspace.id).catch(() => new Map<string, number>()) : Promise.resolve(new Map<string, number>()),
  ]);
  const authors = [...new Set([...threads.authors, ...boards.authors])];
  const names = new Map<string, string>();
  if (authors.length) {
    const rs = await db().execute({ sql: `SELECT id, name FROM users WHERE id IN (${authors.map(() => "?").join(",")})`, args: authors }).catch(() => ({ rows: [] as Row[] }));
    for (const r of rs.rows as Row[]) names.set(String(r.id), String(r.name));
  }
  const naming: Names = { names, viewer: { id: viewer.id, admin } };
  const productions = [...spend.keys(), ...threads.productions, ...boards.runs.map((r) => r._production)];
  const projects = await projectsOf(viewer.id, productions);
  const projectOf = (id: string | null): QueueProject => (id ? projects.get(id) ?? { productionId: id, draftId: null, name: null } : NO_PROJECT);

  type Built = Omit<ActivityRun, "n" | "project"> & { _production: string | null };
  const built: Built[] = [...(threads.runs as Built[]), ...boards.runs];
  /* Numbered per production, oldest first, then listed newest first. */
  const counter = new Map<string, number>();
  const runs: ActivityRun[] = built.sort((a, b) => a.startedAt - b.startedAt).map(({ _production, ...run }) => {
    const key = _production ?? "";
    const n = (counter.get(key) ?? 0) + 1;
    counter.set(key, n);
    const project = projectOf(_production);
    const open = run.open.kind === "board" ? { ...run.open, draftId: project.draftId } : run.open;
    const steps = run.steps.map((s) => ({ ...s, byYou: !!s.by && s.by === viewer.id, by: who(s.by, naming) }));
    return { ...run, n, project, open, steps };
  }).reverse();

  const perProject: ProjectSpend[] = [...spend.entries()]
    .map(([id, settled]) => ({ project: projectOf(id), settled: Math.round(settled * 10) / 10 }))
    .sort((a, b) => b.settled - a.settled);
  return { inCredits, productionId: production, projects: perProject, runs };
}
