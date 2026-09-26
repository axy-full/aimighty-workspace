/**
 * Picking connected-account jobs back up after the page was left: which saved
 * jobs are still open, which of those a status read can still move, what each
 * state is called, and when to ask again.
 *
 * Pure (no fetch, no React, injected timers) so Gen, Business and Viral share
 * one behaviour and a unit spec can drive it. A resumed job is only ever asked
 * for its status — the same leased read the page made before — never re-sent.
 */
import { SET_ASIDE_LABEL } from "./job-state";

export type ResumeStatus = "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
/** The saved-job fields this file reads (every workflow's job view has them). */
export type ResumeJob = { status: string; providerReceipt?: unknown; setAside?: boolean; failureCode?: string | null };

/** Sent, or maybe sent, and not settled: it may be on the account, so the page lists it. */
export const isOpen = (status: string) => status === "dispatching" || status === "accepted" || status === "uncertain";
export const isSettled = (status: string) => status === "completed" || status === "failed";
/**
 * A status read can still move it: the account is rendering it (`accepted`),
 * or it is unconfirmed with a receipt the service can reconcile. A job still
 * `dispatching`, or unconfirmed with nothing to reconcile, never moves on a
 * read — asking again would only repeat the same answer.
 */
export const canProgress = (job: ResumeJob) => job.status === "accepted" || (job.status === "uncertain" && Boolean(job.providerReceipt));

/** Open jobs, newest first; `accept` narrows them to one composer's own. */
export function resumableJobs<J extends ResumeJob & { createdAt: number }>(jobs: readonly J[], accept?: (job: J) => boolean): J[] {
  return jobs.filter((job) => isOpen(job.status) && (!accept || accept(job))).sort((a, b) => b.createdAt - a.createdAt);
}

export type ResumeTone = "blue" | "green" | "red" | "amber" | "idle";
export type ResumePhase = { label: string; tone: ResumeTone };
/**
 * One short label per state, shared by the Gen cards, Business and Viral rows.
 * `following` is false once the page has stopped asking (the read cannot move
 * it, or the job cannot be checked from here): the label then says why, and
 * never claims it is still rendering.
 */
export function resumePhase(job: ResumeJob, following = canProgress(job)): ResumePhase {
  switch (job.status) {
    case "completed": return { label: "Complete", tone: "green" };
    case "failed":
      /* The account finished it but Particl could not keep the result: it may have been billed. */
      return job.failureCode === "invalid_result" ? { label: "Not kept · receipt saved", tone: "red" } : { label: "Failed · not billed", tone: "red" };
    case "accepted": return following ? { label: "Rendering", tone: "blue" } : { label: "Can't be checked", tone: "amber" };
    case "uncertain":
    case "dispatching":
      if (following) return { label: "Confirming", tone: "amber" };
      return { label: job.setAside ? SET_ASIDE_LABEL : "Not confirmed · never sent twice", tone: "amber" };
    /* Priced, never sent: nothing was spent. */
    default: return { label: "Quoted · not sent", tone: "idle" };
  }
}

/** How long a job has been going: "just now", "4 min", "2 h", "3 d". */
export function resumeAge(createdAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - createdAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/** "Rendering · 12 min" while followed; the settled or stopped label alone otherwise. */
export function resumeLine(job: ResumeJob & { createdAt: number }, now: number, following = canProgress(job)): string {
  const phase = resumePhase(job, following);
  return following && isOpen(job.status) ? `${phase.label} · ${resumeAge(job.createdAt, now)}` : phase.label;
}

/** A name cut on a word boundary with an ellipsis, never mid-word. */
export function shortName(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,.;:·-]+$/, "")}…`;
}

/**
 * When to ask again. A rendering job follows the server's own hint (it knows
 * the provider's pace and its poll lease), bounded to 8–60 s; a job only the
 * account can confirm is asked every 30 s. Misses back off, up to 2 minutes.
 */
export function resumeDelayMs(status: string, hintSeconds?: number | null, misses = 0): number {
  const hint = typeof hintSeconds === "number" && Number.isFinite(hintSeconds) ? hintSeconds : 10;
  const base = status === "accepted" ? Math.min(60, Math.max(8, hint)) : 30;
  return Math.min(120, base * 2 ** Math.max(0, Math.min(misses, 3))) * 1000;
}

type Failure = { code?: unknown; status?: unknown };
const codeOf = (error: unknown) => (error && typeof error === "object" && typeof (error as Failure).code === "string" ? (error as Failure).code as string : null);
/**
 * A status read that will fail the same way every time for this job: it was
 * made on an earlier account connection (a different account signed in since),
 * or the job is no longer on record for this person. The page stops asking.
 */
export function resumeGivesUp(error: unknown): boolean {
  const status = error && typeof error === "object" ? (error as Failure).status : null;
  return codeOf(error) === "connection_changed" || status === 404 || status === 403;
}

/** A failed status read, in the product's words. A reconnect is named plainly. */
export function resumeProblem(error: unknown, message?: string | null): string {
  const code = codeOf(error);
  if (code === "connection_changed") return "Started on an earlier account connection, so it can't be checked from here.";
  if (resumeGivesUp(error)) return "This job can no longer be checked from here.";
  if (code === "reconnect_required") return "Reconnect the account in Workspace › Engines to finish this take.";
  if (code === "original_quota") return "Workspace storage is full. Make room to collect this take.";
  const text = typeof message === "string" ? message.trim() : error instanceof Error ? error.message.trim() : "";
  return text && text.length <= 200 ? text : "The account could not be reached. Trying again.";
}

/**
 * A failed status read on a job the page is still following, as one line on
 * the job: a reconnect or full storage says what to do; anything else (a
 * dropped connection, a busy or failing server) says the check did not go
 * through — never the raw error — and that it is asked again.
 */
export function checkingProblem(error: unknown, what = "this take"): string {
  const code = codeOf(error);
  const status = error && typeof error === "object" ? (error as Failure).status : null;
  const said = code === "reconnect_required" || code === "original_quota" ? resumeProblem(error)
    : typeof status === "number" ? `Could not check ${what}.` : "The connection dropped.";
  return `${said} Checking again shortly.`;
}

export type ResumeReply<J> = { job: J; pollAfterSeconds?: number | null };
export type ResumeTracker<J> = {
  /** Start following each job a read can still move, if not already followed. */
  track: (jobs: readonly J[]) => void;
  /** Stop following one job (its composer follows it, or it was dismissed). */
  forget: (id: string) => void;
  /** Stop everything; late replies are ignored. */
  stop: () => void;
  followed: () => string[];
};

/**
 * Follow several jobs at once, each on its own clock: ask, report, and ask
 * again while the account is rendering it. It stops at a settled job, at a
 * read that leaves the job where no further read can move it, and at an error
 * that would repeat for this job. A passing error backs off and asks again;
 * one job's error never stops another's.
 */
export function createResumeTracker<J extends ResumeJob & { id: string }>(deps: {
  status: (id: string) => Promise<ResumeReply<J>>;
  onUpdate?: (job: J) => void;
  onSettled?: (job: J) => void;
  /** Stopped without settling: the read cannot move it (`error` null), or it cannot be checked from here. */
  onStalled?: (id: string, error: unknown) => void;
  onProblem?: (id: string, error: unknown) => void;
  /** First read soon after the page opens: a job may have finished while it was closed. */
  firstDelayMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): ResumeTracker<J> {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const timers = new Map<string, unknown>();
  let stopped = false;
  const follow = (id: string, status: string, delay: number, misses: number) => {
    timers.set(id, schedule(() => void ask(id, status, misses), delay));
  };
  const ask = async (id: string, status: string, misses: number) => {
    if (stopped || !timers.has(id)) return;
    try {
      const reply = await deps.status(id);
      if (stopped || !timers.has(id)) return;
      deps.onUpdate?.(reply.job);
      if (isSettled(reply.job.status)) {
        timers.delete(id);
        deps.onSettled?.(reply.job);
        return;
      }
      /* Only a rendering job moves on the next read; anything else would answer the same again. */
      if (reply.job.status !== "accepted") {
        timers.delete(id);
        deps.onStalled?.(id, null);
        return;
      }
      follow(id, reply.job.status, resumeDelayMs(reply.job.status, reply.pollAfterSeconds), 0);
    } catch (error) {
      if (stopped || !timers.has(id)) return;
      if (resumeGivesUp(error)) {
        timers.delete(id);
        deps.onStalled?.(id, error);
        return;
      }
      deps.onProblem?.(id, error);
      follow(id, status, resumeDelayMs(status, null, misses + 1), misses + 1);
    }
  };
  return {
    track(jobs) {
      if (stopped) return;
      for (const job of jobs) if (canProgress(job) && !timers.has(job.id)) follow(job.id, job.status, deps.firstDelayMs ?? 1200, 0);
    },
    forget(id) {
      const handle = timers.get(id);
      if (handle !== undefined) cancel(handle);
      timers.delete(id);
    },
    stop() {
      stopped = true;
      for (const handle of timers.values()) cancel(handle);
      timers.clear();
    },
    followed: () => [...timers.keys()],
  };
}
