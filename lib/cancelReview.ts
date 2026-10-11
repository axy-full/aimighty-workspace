/**
 * Cancels that stayed charged, kept where the owner can read them and refund by hand (owner's decision on #639).
 *
 * A fal job is free only on an explicit cancel signal. When we asked fal to cancel a queued job and could not confirm it (the PUT timed
 * out, or fal answered with an error), and the job later reads 404 (fal no longer has it, with no word of a cancellation), the take
 * stays charged as it was built to. Each such case is filed here, on the platform desk's reports list (the same table and desk page
 * as a person's report, `reports` and /api/admin/reports: open until the owner marks it handled), so a refund by hand has what it
 * needs: the job id, the workspace, the time, and what fal answered (status codes and bodies, sanitised).
 *
 * Nothing secret and nothing from the prompt is kept: fal's words go through the same redaction as every provider message
 * (lib/providerOutcome.ts providerText), and no input, URL or credential is read here. Best-effort: filing never throws, because a
 * review note that could fail a poll would be worse than none. No new table: `reports` already exists.
 *
 * To read them: the platform desk's reports (GET /api/admin/reports, super admin), or in the platform database
 *   SELECT created_at, workspace_id, url, details FROM reports WHERE reason LIKE 'Queued cancel not confirmed%' AND handled_at IS NULL;
 */
import { now, platformDb, platformReady } from "./platform";
import { providerText } from "./providerOutcome";

/** One answer from fal (or the lack of one), as it may be kept. */
export type CancelReply = { at: number; kind: "http" | "timeout" | "network" | "other"; status: number | null; text: string | null };
/** What a cancel attempt saw, kept on the take (params.cancelTrail) until the job ends. */
export type CancelTrail = { at: number; put: CancelReply | null; after: CancelReply | null };

export const REVIEW_REASON = "Queued cancel not confirmed; the job was then charged. Review for a refund.";

/** An error from a provider call, reduced to what may be kept: when, its HTTP status, and its words (bounded and redacted). */
export function replyOf(error: unknown, at: number = now()): CancelReply {
  const e = error as { name?: unknown; message?: unknown; status?: unknown; body?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const message = typeof e?.message === "string" ? e.message : "";
  const status = typeof e?.status === "number" && Number.isFinite(e.status) ? e.status : null;
  let body = "";
  try { body = e?.body == null ? "" : JSON.stringify(e.body); } catch { body = ""; }
  const kind = name === "TimeoutError" || name === "AbortError" || /time(d)?[ -]?out|aborted/i.test(message) ? "timeout"
    : status !== null ? "http" : /fetch failed|network|econn|enotfound|socket/i.test(message) ? "network" : "other";
  return { at, kind, status, text: providerText(`${message} ${body}`.trim(), 400) };
}

export type CancelReviewInput = {
  jobId: string;
  workspaceId: string | null;
  provider: string;
  trail: CancelTrail;
  /** Whether fal had said yes to the cancel (a 202) before the job read as gone. */
  cancelAccepted: boolean;
  /** What fal answered when the job read as gone. */
  gone: CancelReply;
};

type Deps = { platform?: () => Promise<{ execute: (s: { sql: string; args: (string | number | null)[] }) => Promise<unknown> }>; clock?: () => number; log?: (line: string) => void; timeoutMs?: number };

/** How long a poll waits for the note to be kept before it goes on without it: filing never holds up what the poll is for. */
export const FILE_TIMEOUT_MS = 3_000;
/** One note per job, whatever polls overlap or retry: the row's id is made from the job's. */
export const reviewIdOf = (jobId: string) => `rp_cancel_${jobId}`;

/**
 * Files one review note on the platform desk, once per job. True when it is kept (now or already); false when it could not be
 * (an error, or no answer within FILE_TIMEOUT_MS). Never throws. Call it AFTER the take's outcome is written: the note is only
 * about a charge that has already been decided, and nothing here can change that charge.
 */
export async function fileCancelReview(input: CancelReviewInput, deps: Deps = {}): Promise<boolean> {
  const at = (deps.clock ?? now)();
  const record = {
    jobId: input.jobId, provider: input.provider, filedAt: new Date(at).toISOString(), cancelAccepted: input.cancelAccepted,
    cancelAsked: input.trail.put ?? { at: input.trail.at, kind: "other", status: null, text: null },
    afterCancel: input.trail.after, gone: input.gone,
  };
  /* A fixed-shape line as well, like the dispatch lines: identifiers and codes only. */
  try {
    (deps.log ?? ((line) => console.error(line)))(JSON.stringify({ level: "error", event: "queued_cancel.charged_review", jobId: input.jobId, workspaceId: input.workspaceId, provider: input.provider, putStatus: input.trail.put?.status ?? null, goneStatus: input.gone.status }));
  } catch { /* a log line is never worth a failed poll */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const keep = (async () => {
      const db = deps.platform ? await deps.platform() : (await platformReady(), platformDb());
      await db.execute({
        sql: `INSERT OR IGNORE INTO reports (id, ip_hash, url, reason, details, email, account_id, workspace_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        args: [reviewIdOf(input.jobId), null, `/api/generations/${input.jobId}/cancel`, REVIEW_REASON, JSON.stringify(record).slice(0, 4000), null, null, input.workspaceId, at],
      });
      return true;
    })();
    keep.catch(() => undefined);
    const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), deps.timeoutMs ?? FILE_TIMEOUT_MS); });
    return await Promise.race([keep, late]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
