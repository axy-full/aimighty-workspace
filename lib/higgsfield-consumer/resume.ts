/**
 * Picking connected-account jobs back up after the page was left: which saved
 * jobs are still open, which of those a status read can still move, what each
 * state is called, and what a failed read means for the job.
 *
 * Pure (no fetch, no React) so Gen, Business and Viral say one thing and a
 * unit spec can check it. The reading itself is the shell's collector's
 * (lib/shell/connected-collector.ts): a picked-up job is only ever asked for
 * its status — the same leased read the page made before — never re-sent.
 */
import { SET_ASIDE_LABEL } from "./job-state";

export type ResumeStatus = "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
/** The saved-job fields this file reads (every workflow's job view has them). */
export type ResumeJob = { status: string; providerReceipt?: unknown; setAside?: boolean; failureCode?: string | null };

/** Sent, or maybe sent, and not settled: it may be on the account, so the page lists it. */
export const isOpen = (status: string) => status === "dispatching" || status === "accepted" || status === "uncertain";
/**
 * A status read can still move it: the account is rendering it (`accepted`),
 * or it is unconfirmed with a receipt the service can reconcile. A job still
 * `dispatching`, or unconfirmed with nothing to reconcile, never moves on a
 * read — asking again would only repeat the same answer.
 */
export const canProgress = (job: ResumeJob) => job.status === "accepted" || (job.status === "uncertain" && Boolean(job.providerReceipt));

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
