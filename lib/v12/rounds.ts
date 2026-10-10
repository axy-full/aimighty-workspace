/**
 * Client rounds (redesign P2-c; docs/redesign/inventory.md § 6.7, § 11; prototype README: client approvals happen outside the
 * app, in WhatsApp or email, so there is no client sign-in and no "Send" on a card).
 *
 * The flow, on today's paths:
 *  1. A person pastes the client's reply into the board's bar. It is recognised (a change per "Shot N") and asked of Atomik as
 *     today's ask (`agent.plan`, the figure on the button as its limit), in words that say what it is (`clientRoundGoal`).
 *  2. Atomik's plan lists a change per shot, each at the server's own price (the plan card, lib/workbench plan quote); the
 *     person approves it once ("Approve all · N cr": today's plan approval, which only a person gives).
 *  3. Once approved, the round is kept in the board's draft (`boardRounds`: additive and optional draft JSON, like
 *     `boardStages`; no table): its number, when, what each change was, and which take each shot had before (R1).
 *  4. The new takes land as Round 2: a tag on the shot, a "What changed" list on the stage, Compare R1 / R2 in Cut, and the
 *     list as words to copy into WhatsApp or email.
 *
 * Pure.
 */
import type { PlanModel, PlanStep } from "@/components/graphite/board/cards/plan/model";

export type RoundChange = { shot: number; text: string };
export type BoardRound = {
  /** 2 for the first client round (the board as first made is round 1). */
  n: number;
  /** The Atomik run whose plan was approved. */
  runId: string;
  /** When the plan was approved (ms). */
  at: number;
  changes: RoundChange[];
  /** Each changed shot's take before the round (generation id), by shot number: R1, for Compare. */
  before: Record<string, string>;
};

export const CLIENT_MARK = "Client feedback, one change per shot; the rest stay as they are: ";
const GOAL_MAX = 2000;

/** The feedback as the client wrote it, line by line, with the shot each line is about. */
export function parseFeedback(text: string): RoundChange[] {
  const out = new Map<number, string>();
  const re = /shots?\s*#?\s*(\d{1,2})\b[\s:–—,-]*([^\n.;]+)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const shot = Number(m[1]);
    const words = m[2].replace(/\s+/g, " ").replace(/^[\s:–—,-]+|[\s,]+$/g, "");
    if (shot > 0 && words.length >= 2 && !out.has(shot)) out.set(shot, words.charAt(0).toUpperCase() + words.slice(1, 160));
  }
  return [...out].map(([shot, words]) => ({ shot, text: words })).sort((a, b) => a.shot - b.shot);
}

/** Words that read as a client's reply: a change for two or more shots, or one named as the client's. */
export function looksLikeClientFeedback(text: string): boolean {
  const changes = parseFeedback(text);
  return changes.length >= 2 || (changes.length === 1 && /\b(client|feedback)\b/i.test(text));
}

/** The ask, said as what it is. */
export function clientRoundGoal(words: string): string {
  return `${CLIENT_MARK}${words.trim()}`.slice(0, GOAL_MAX);
}
export const isClientRound = (goal: string | null | undefined): boolean => typeof goal === "string" && goal.includes(CLIENT_MARK);
/** The client's words, out of a run's goal. */
export function feedbackOf(goal: string): string {
  const at = goal.indexOf(CLIENT_MARK);
  return at < 0 ? goal : goal.slice(at + CLIENT_MARK.length).replace(/\s*\(\d+:\d+(, [^)]*)?\)\s*$/, "");
}

const shotOfTitle = (title: string, index: number): number => {
  const m = /shot\s*#?\s*(\d{1,2})\b/i.exec(title);
  return m ? Number(m[1]) : index + 1;
};

/**
 * The plan as a client round: the same plan, steps and prices as the server quoted them, in a round's words. "Client round ·
 * 3 changes", a step per shot with what the client asked, and the one approval "Approve all · N cr".
 */
export function clientRoundModel(model: PlanModel, goal: string): PlanModel {
  const asked = new Map(parseFeedback(feedbackOf(goal)).map((c) => [c.shot, c.text]));
  const steps: PlanStep[] = model.steps.map((step, i) => {
    const shot = shotOfTitle(step.title, i);
    const text = asked.get(shot);
    return text ? { ...step, title: `Shot ${shot} · ${text}` } : step;
  });
  const n = steps.length;
  const title = model.phase === "proposal" || model.phase === "planning" ? "Client round" : "Round 2";
  const primary = model.primary && model.primary.kind === "plan" ? { ...model.primary, label: model.primary.label.replace(/^Approve\b/, "Approve all") } : model.primary;
  return { ...model, title: n ? `${title} · ${n} ${n === 1 ? "change" : "changes"}` : title, steps, primary };
}

export const ROUND_LINE = "The rest stay approved. Results land as Round 2 with a What changed list.";

/** The round a plan's approval makes: what the client asked, for the shots the plan renders again. */
export function roundOf(args: { runId: string; goal: string; stepTitles: readonly string[]; rounds: readonly BoardRound[]; before: Record<string, string>; at: number }): BoardRound {
  const asked = new Map(parseFeedback(feedbackOf(args.goal)).map((c) => [c.shot, c.text]));
  const seen = new Set<number>();
  const changes: RoundChange[] = [];
  args.stepTitles.forEach((title, i) => {
    const shot = shotOfTitle(title, i);
    if (seen.has(shot)) return;
    seen.add(shot);
    changes.push({ shot, text: asked.get(shot) || title.replace(/^shot\s*#?\d+\s*[·:–—-]?\s*/i, "").trim() || `Shot ${shot}` });
  });
  changes.sort((a, b) => a.shot - b.shot);
  const before = Object.fromEntries(changes.flatMap((c) => (args.before[String(c.shot)] ? [[String(c.shot), args.before[String(c.shot)]]] : [])));
  return { n: Math.max(1, ...args.rounds.map((r) => r.n)) + 1, runId: args.runId, at: args.at, changes, before };
}

export const hasRound = (rounds: readonly BoardRound[] | undefined, runId: string) => Boolean(rounds?.some((r) => r.runId === runId));
/** The newest round, or null. */
export const latestRound = (rounds: readonly BoardRound[] | undefined): BoardRound | null => (rounds?.length ? rounds.reduce((a, b) => (b.n > a.n ? b : a)) : null);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "9 Oct 2026". */
export const roundDate = (at: number): string => { const d = new Date(at); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };

/** The round's header badge: "Round 2 · 3 changed". */
export const roundBadge = (round: BoardRound): string => `Round ${round.n} · ${round.changes.length} changed`;

/** The what-changed list as words to paste into WhatsApp or an email: "Board · R2 · 9 Oct 2026", then a line per change. */
export function whatChangedText(board: string, round: BoardRound, total?: number): string {
  const lines = round.changes.map((c) => `• Shot ${c.shot}: ${c.text}`);
  const rest = total != null && total > round.changes.length ? [`The other ${total - round.changes.length} shots are as you approved them.`] : [];
  return [`${board || "Board"} · R${round.n} · ${roundDate(round.at)}`, `What changed in round ${round.n}:`, ...lines, ...rest].join("\n");
}

/** The round a take of a shot belongs to: the newest round that changed this shot and began before the take was asked for. */
export function takeRound(rounds: readonly BoardRound[] | undefined, shot: number, createdAt: number): number | null {
  let found: number | null = null;
  for (const r of rounds ?? []) if (createdAt >= r.at && r.changes.some((c) => c.shot === shot) && (found == null || r.n > found)) found = r.n;
  return found;
}
