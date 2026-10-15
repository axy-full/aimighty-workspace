// Pure: no database, no server module, so the console's screen can import the label and the window (lib/atRisk.ts holds what reads the database).
/**
 * The one definition of an unsaved take (owner, 15 Oct 2026: "the counter and the rescuer use the same 72-hour window; older unsaved takes are listed as 'lost (older than 3 days)'
 * instead of 'at risk' forever; the cron logs a reason for every kind it can't save").
 *
 *   unsaved  = a take that succeeded, is not deleted and has no stored copy.
 *   at risk  = unsaved and made within the last 72 hours: the heartbeat (lib/jobs.ts › syncPending) still tries to save it.
 *   lost     = unsaved and made 72 hours ago or more: nothing tries any more, so it is listed as "lost (older than 3 days)".
 *
 * Every reader of that window uses the constants and fragments here and has no copy of its own: the health counter (app/api/health/route.ts), the heartbeat's counts and the choice of
 * what it tries (app/api/cron/sync/route.ts, lib/jobs.ts), and the console's failed-saves list (lib/platformFailedSaves.ts). It counts every kind of take (video, still, sound,
 * 3D), not only videos. Nothing here calls a provider or starts a render.
 */
export const AT_RISK_WINDOW_MS = 72 * 3_600_000;
export const LOST_LABEL = "lost (older than 3 days)";

/** A take made after this is at risk; one made at or before it, and still unsaved, is lost. */
export const atRiskHorizon = (at: number = Date.now()): number => at - AT_RISK_WINDOW_MS;
/** Whether a take made at `createdAt` is past the window as of `at` (and so, if unsaved, lost). */
export const isLostAge = (createdAt: number, at: number = Date.now()): boolean => createdAt <= atRiskHorizon(at);

/** SQL: a succeeded, undeleted take with no stored copy (alias `g`). No window: the caller adds `AT_RISK_SQL` or `LOST_SQL`. */
export const UNSAVED_SQL = (a = "g"): string => `${a}.status = 'succeeded' AND ${a}.deleted = 0 AND ${a}.stored_url IS NULL`;
/** SQL: made inside the window. One `?` argument: the horizon. */
export const IN_WINDOW_SQL = (a = "g"): string => `${a}.created_at > ?`;
/** SQL: made at or before the horizon. One `?` argument: the horizon. */
export const PAST_WINDOW_SQL = (a = "g"): string => `${a}.created_at <= ?`;

/** The counts of one workspace's takes in one read: saved, at risk (inside the window) and lost (past it). Arguments: the horizon, twice. The one SQL the health counter and the heartbeat both run. */
export const AT_RISK_COUNTS_SQL = `SELECT SUM(CASE WHEN g.stored_url IS NOT NULL THEN 1 ELSE 0 END) AS saved,
       SUM(CASE WHEN g.stored_url IS NULL AND ${IN_WINDOW_SQL()} THEN 1 ELSE 0 END) AS atrisk,
       SUM(CASE WHEN g.stored_url IS NULL AND ${PAST_WINDOW_SQL()} THEN 1 ELSE 0 END) AS lost
  FROM generations g WHERE g.status = 'succeeded' AND g.deleted = 0`;
export const atRiskCountsQuery = (horizon: number): { sql: string; args: number[] } => ({ sql: AT_RISK_COUNTS_SQL, args: [horizon, horizon] });
