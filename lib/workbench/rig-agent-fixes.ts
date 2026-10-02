import { EDIT_MOVES, getTask, sourceProblem } from "../tasks";
import type { LiveStep, StepRow } from "./rig-agent-store";
import { CHECK_MASTER, VERIFY_CHECKS, VERIFY_CHECK_LABELS, type MasterKind, type Verdict, type VerifyCheck, type VerifyCheckResult } from "./verify";

/*
 * Atomik fixes a failed check (plan §6 "Targeted fixes only"; PR 11): the pure half.
 *
 * A take that fails its check against the production's masters is never
 * rendered again from scratch. Each failed check maps to one existing edit
 * move (lib/tasks.ts EDIT_MOVES), applied to the failed take, with the master
 * that anchors the check attached as a reference. The fix is a new take; the
 * failed one stays, marked as having failed its check.
 *
 *   Check        Still (reference-conditioned re-edit)   Video (Seedance Edit)
 *   Identity     replace, with the Cast master          replace, with the Cast master
 *   Wardrobe     wardrobe, with the Cast master         wardrobe, with the Cast master
 *   Environment  background, with the plate             background, with the plate
 *   Props        replace (add when missing)             replace (add when missing)
 *   Artifacts    remove                                 remove; flicker or morphing over time has none
 *
 * The stack has no masked still inpaint (the still tools are outpaint, cutout
 * and upscale), so a still fix is a re-edit of the failed still with the
 * master attached, not a pixel lock. A video fix is a Seedance Edit of the
 * failed clip: admission takes an edit only from a 480p or 720p source of 4 to
 * 30 seconds (lib/tasks.ts sourceProblem), and an edit is never a draft, so it
 * renders at full quality, priced on its source. For video identity the plan
 * also names Transform's subject swap; Seedance Edit's "replace" is used here.
 *
 * The code decides when Atomik may fix on its own, strictly (owner, 28
 * September: "when a check is unsure, it asks you"): only when every check
 * that did not pass failed outright, each has a targeted fix, and each says
 * what it saw (the fix writer only fills the move's template from those
 * reasons). One move per fix, the most important failed check first; the next
 * check shows what is left. After MAX_AUTO_FIXES fixes on one shot, a person
 * decides (the owner's choice), and the run carries on with its other shots.
 */

/** How many fixes Atomik makes on one shot on its own before a person decides. */
export const MAX_AUTO_FIXES = 2;

export type TakeKind = "image" | "video";
/** The take being fixed: a still or a clip, and for a clip what admission reads of it as an edit's source. */
export type FixTake = { kind: TakeKind; source?: { resolution?: string; duration?: number } | null };
/** The edit moves a fix may use: each template carries words the engine reads as an edit (lib/tasks.ts). */
export type FixMoveId = "replace" | "background" | "add" | "remove" | "wardrobe";
/** How a fix is made: never a fresh generation, always an edit of the failed take. */
export type FixTask = "video-edit" | "still-edit";

export type FixMove = {
  check: VerifyCheck;
  task: FixTask;
  move: FixMoveId;
  /** The move's template (`{}` is what the fix writer fills in from the check's reasons). */
  template: string;
  /** The master attached as a reference; none for artifacts, which compare against nothing. */
  master: MasterKind | null;
  /** A fix always starts from the take that failed. */
  source: "failed-take";
};

/** The move for each check, on a still and on a video (null: no targeted fix). Props may become "add" (fixMoveFor). */
export const FIX_TABLE: Readonly<Record<VerifyCheck, Readonly<Record<TakeKind, FixMoveId | null>>>> = {
  identity: { image: "replace", video: "replace" },
  wardrobe: { image: "wardrobe", video: "wardrobe" },
  environment: { image: "background", video: "background" },
  props: { image: "replace", video: "replace" },
  artifacts: { image: "remove", video: "remove" },
};

/** Artifacts in time (flicker, morphing, jitter): an edit of the clip cannot target them. */
const TEMPORAL = /\b(flicker\w*|morph\w*|jitter\w*|shimmer\w*|strob\w*|temporal\w*|boil\w*|popping|pops in|between frames|frame[- ]to[- ]frame|across frames|over time)\b/i;
/** A prop the take does not show at all: added, not replaced. */
const MISSING = /\b(missing|absent|no sign of|nowhere|not (?:in|present|visible|shown|there|seen)|cannot be seen|can't be seen|isn't (?:in|there|visible))\b/i;

const templateOf = (move: FixMoveId): string => {
  const found = EDIT_MOVES.find((m) => m.id === move);
  if (!found) throw new Error(`No edit move ${move}.`);
  return found.template;
};

/** Why a failed check has no targeted fix on this take, or null when it has one. */
export function noFixReason(result: Pick<VerifyCheckResult, "check" | "reasons">, take: FixTake): string | null {
  if (!FIX_TABLE[result.check][take.kind]) return `${VERIFY_CHECK_LABELS[result.check]} has no targeted fix.`;
  if (!result.reasons.some((r) => r.trim())) return `${VERIFY_CHECK_LABELS[result.check]} failed without saying what it saw, so there is nothing to aim a fix at.`;
  if (result.check === "artifacts" && take.kind === "video" && result.reasons.some((r) => TEMPORAL.test(r)))
    return "Flicker or morphing over time has no targeted fix.";
  if (take.kind === "video" && take.source) {
    const problem = sourceProblem(getTask("edit"), take.source, "render");
    if (problem) return `This take cannot be edited: ${problem}`;
  }
  return null;
}

/** The fix for one failed check (null when it has none: noFixReason says why). */
export function fixMoveFor(result: Pick<VerifyCheckResult, "check" | "reasons">, take: FixTake): FixMove | null {
  if (noFixReason(result, take)) return null;
  let move = FIX_TABLE[result.check][take.kind]!;
  if (result.check === "props" && result.reasons.some((r) => MISSING.test(r))) move = "add";
  return { check: result.check, task: take.kind === "video" ? "video-edit" : "still-edit", move, template: templateOf(move), master: CHECK_MASTER[result.check], source: "failed-take" };
}

/** A fix as a step keeps it (its check and move), as the fix writer and the edit are made from it. */
export function fixMove(check: VerifyCheck, move: FixMoveId, take: TakeKind): FixMove {
  return { check, task: take === "video" ? "video-edit" : "still-edit", move, template: templateOf(move), master: CHECK_MASTER[check], source: "failed-take" };
}

/**
 * The fix a person asks for ("try another fix"): the most important failed check that has a targeted
 * fix on this take, whatever else the scorecard says (the person has looked); null when none has one.
 */
export function personFix(checks: readonly Pick<VerifyCheckResult, "check" | "verdict" | "reasons">[], take: FixTake): { fix: FixMove; reasons: string[] } | null {
  for (const check of VERIFY_CHECKS) {
    const result = checks.find((c) => c.check === check && c.verdict === "fail");
    const fix = result ? fixMoveFor(result, take) : null;
    if (result && fix) return { fix, reasons: result.reasons.map((r) => r.trim()).filter(Boolean).slice(0, 3) };
  }
  return null;
}

/** Why a shot goes to a person instead of being fixed. */
export type HandOver = "unsure" | "no-fix" | "fixes-used" | "cannot-fix";

export type FixChoice =
  | { kind: "pass" }
  | { kind: "fix"; fix: FixMove; reasons: string[] }
  | { kind: "person"; why: HandOver; check: VerifyCheck | null; words: string };

const labels = (checks: readonly VerifyCheckResult[]) => checks.map((c) => VERIFY_CHECK_LABELS[c.check]).join(", ");

/**
 * What a scorecard calls for: nothing (every check passed), one targeted fix
 * (the most important failed check, with its reasons), or a person — when any
 * check is unsure, or any failed check has no targeted fix.
 */
export function chooseFix(checks: readonly VerifyCheckResult[], take: FixTake): FixChoice {
  if (!checks.length) return { kind: "person", why: "unsure", check: null, words: "The check came back empty. Look at the take and decide." };
  const unsure = checks.filter((c) => c.verdict === "unsure");
  if (unsure.length) return { kind: "person", why: "unsure", check: unsure[0].check, words: `${labels(unsure)} ${unsure.length === 1 ? "was" : "were"} unsure. Look at the take and decide.` };
  const failed = VERIFY_CHECKS.flatMap((check) => checks.filter((c) => c.check === check && c.verdict === "fail"));
  if (!failed.length) return { kind: "pass" };
  for (const result of failed) {
    const none = noFixReason(result, take);
    if (none) return { kind: "person", why: "no-fix", check: result.check, words: `${none} Look at the take and decide.` };
  }
  const first = failed[0];
  return { kind: "fix", fix: fixMoveFor(first, take)!, reasons: first.reasons.map((r) => r.trim()).filter(Boolean).slice(0, 3) };
}

export type AfterCheck =
  | { kind: "done" }
  | { kind: "fix"; n: number; fix: FixMove; reasons: string[] }
  | { kind: "person"; why: HandOver; check: VerifyCheck | null; words: string };

/**
 * What follows a take's check (plan §6): a pass is done; a fail with a
 * targeted fix is fixed, up to MAX_AUTO_FIXES times on one shot; anything else
 * goes to a person. `fixes` is how many fixes this shot has had; `canFix` is
 * whether this build fixes at all (until it does, every fail goes to a person).
 */
export function afterCheck(input: { verdict: Verdict; checks: readonly VerifyCheckResult[]; take: FixTake; fixes: number; canFix: boolean }): AfterCheck {
  const choice = chooseFix(input.checks, input.take);
  if (input.verdict === "pass")
    /* The code's verdict and its scorecard agree, or a person looks. */
    return choice.kind === "pass" ? { kind: "done" } : { kind: "person", why: "unsure", check: null, words: "The check's verdict and its scorecard disagree. Look at the take and decide." };
  if (choice.kind === "person") return choice;
  if (choice.kind === "pass" || input.verdict === "needs_you") return { kind: "person", why: "unsure", check: null, words: "The check needs a person. Look at the take and decide." };
  if (input.fixes >= MAX_AUTO_FIXES)
    return { kind: "person", why: "fixes-used", check: choice.fix.check, words: `Atomik made ${MAX_AUTO_FIXES} fixes and the take still fails ${VERIFY_CHECK_LABELS[choice.fix.check]}. Look at it and decide.` };
  if (!input.canFix) return { kind: "person", why: "cannot-fix", check: choice.fix.check, words: `${VERIFY_CHECK_LABELS[choice.fix.check]} failed. Look at the take and decide.` };
  return { kind: "fix", n: input.fixes + 1, fix: choice.fix, reasons: choice.reasons };
}

/** What a round on a shot makes: its k-th fix (an edit of the failed take), or a render again (a person's choice). */
export type RoundKind = { kind: "fix"; fix: number } | { kind: "rerender" };

/** The steps round n on a shot adds while the run is live: what it makes, then the check of that take. */
export function roundSteps(nodeId: string, title: string, round: number, made: RoundKind): LiveStep[] {
  if (!Number.isInteger(round) || round < 1) throw new Error("A round is numbered from 1.");
  if (made.kind === "fix") {
    if (!Number.isInteger(made.fix) || made.fix < 1) throw new Error("A fix is numbered from 1.");
    return [
      { tool: "fix", purpose: "fix", label: `Fix ${made.fix} · ${title}`, nodeId, round },
      { tool: "verify", purpose: "verify", label: `Check fix ${made.fix} · ${title}`, nodeId, round },
    ];
  }
  return [
    { tool: "render", purpose: "take", label: `Render again · ${title}`, nodeId, round },
    { tool: "verify", purpose: "verify", label: `Check again · ${title}`, nodeId, round },
  ];
}

type Counted = readonly Pick<StepRow, "purpose" | "nodeId" | "state">[];
/**
 * The fixes that count toward MAX_AUTO_FIXES on a shot: those whose take landed. A fix the provider
 * failed does not count (the shot then waits for a person, and nothing is retried on its own).
 */
export function landedFixes(steps: Counted, nodeId: string): number {
  return steps.filter((s) => s.purpose === "fix" && s.nodeId === nodeId && s.state === "done").length;
}

/** The number the shot's next fix is called by: every fix it has had in this run, plus one. */
export function nextFixNumber(steps: readonly Pick<StepRow, "purpose" | "nodeId">[], nodeId: string): number {
  return steps.filter((s) => s.purpose === "fix" && s.nodeId === nodeId).length + 1;
}
