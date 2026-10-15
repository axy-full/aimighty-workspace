/** What reads the database about unsaved takes: the counts, the list the heartbeat classifies, why it cannot save some, and the once-a-day log line. The window and its SQL are in ./atRiskWindow (pure, so a screen may import them). */
import { db, ready } from "./db";
import { setSetting } from "./settings";
import { requireTenant } from "./tenant";
import { ASTRA_MODEL } from "./astra";
import { TOPAZ_IMAGE_MODEL } from "./topaz";
import { isHiggsfieldVideoModel } from "./cinemaStudioTypes";
import { RETAINED_CONSUMER_ORIGINAL_SQL } from "./higgsfield-consumer/video-original";
import { uploadReservationsReady } from "./uploadReservations";

export { AT_RISK_WINDOW_MS, AT_RISK_COUNTS_SQL, IN_WINDOW_SQL, LOST_LABEL, PAST_WINDOW_SQL, UNSAVED_SQL, atRiskCountsQuery, atRiskHorizon, isLostAge } from "./atRiskWindow";
import { IN_WINDOW_SQL, UNSAVED_SQL, atRiskCountsQuery } from "./atRiskWindow";

export type AtRiskCounts = { saved: number; atRisk: number; lost: number };

/** This workspace's counts, all in one read, at a horizon fixed by the caller (a run uses one horizon before and after, so a take ageing out between them is not "rescued"). */
export async function atRiskCounts(horizon: number): Promise<AtRiskCounts> {
  await ready();
  const row = (await db().execute(atRiskCountsQuery(horizon))).rows[0];
  return { saved: Number(row?.saved ?? 0), atRisk: Number(row?.atrisk ?? 0), lost: Number(row?.lost ?? 0) };
}

/* ── Why the heartbeat cannot save a take ────────────────────────────── */

/** What the classifier reads of a row: no prompt, no URL. */
export type UnsavedFacts = {
  kind: string; provider: string | null; model: string; arkTaskId: string | null;
  params: Record<string, unknown>;
  /** A connected-account original the heartbeat never selects (RETAINED_CONSUMER_ORIGINAL_SQL). */
  retainedOriginal?: boolean;
};

/** One short code per reason, written as a log field: never free text from a provider. */
export type UnsavableReason =
  | "dub_row" | "seal_queued_only" | "claims_queued_only" | "astra_claim_queued_only" | "fal_no_request_ref" | "no_task_ref" | "retained_original";

/**
 * Why the heartbeat has no way to save this unsaved take, or null when it has one. It mirrors, in the order of the code, the paths a succeeded take with no stored copy takes
 * in lib/jobs.ts (syncPending, then syncGeneration) and lib/falVideo.ts (syncFalVideo), from the row alone; it reads and calls nothing:
 *  - dub_row: a dubbing project's row is advanced by its own workflow, never by the save.
 *  - seal_queued_only: a still or sound with a saved outcome only seals it, and the seal writes rows that are still queued or running, never a succeeded one.
 *  - claims_queued_only: a connected-account still or video and a Topaz still are collected by claims that take only queued or running rows.
 *  - astra_claim_queued_only: the same for the fal 3D upscale (Astra) video.
 *  - fal_no_request_ref: a fal video with no request id or endpoint saved has nothing to ask fal about.
 *  - no_task_ref: no Ark task id and none of the above: there is nothing to poll.
 *  - retained_original: a connected-account original kept elsewhere is left out of the heartbeat's selection.
 */
export function whyNotSaved(f: UnsavedFacts): UnsavableReason | null {
  const p = f.params;
  if (f.retainedOriginal) return "retained_original";
  if (f.kind === "audio" && p.task === "dub") return "dub_row";
  if ((f.kind === "image" || f.kind === "audio") && p.producedOutcome) return "seal_queued_only";
  if (f.provider === "fal" && f.kind === "image" && p.falRequestId) return null;
  if (f.kind === "image" && f.provider === "higgsfield") return "claims_queued_only";
  if (f.kind === "video" && f.provider === "higgsfield" && isHiggsfieldVideoModel(f.model)) return "claims_queued_only";
  if (f.kind === "image" && f.model === TOPAZ_IMAGE_MODEL && p.falStillRequestId) return "claims_queued_only";
  if (f.provider === "fal" && f.kind === "video") {
    if (f.model === ASTRA_MODEL) return "astra_claim_queued_only";
    return !p.falRequestId || !p.falModel ? "fal_no_request_ref" : null;
  }
  if (!f.arkTaskId) return "no_task_ref";
  return null;
}

export type AtRiskRow = UnsavedFacts & { id: string; createdAt: number };

/** The at-risk takes of this workspace, newest first, as the facts the classifier reads. */
export async function listAtRisk(horizon: number, limit: number): Promise<AtRiskRow[]> {
  await ready();
  /* The connected-account originals table the selection reads below is made here, as syncPending makes it before its own read. */
  await uploadReservationsReady();
  const rs = await db().execute({
    sql: `SELECT g.id, g.kind, g.provider, g.model, g.ark_task_id, g.params, g.created_at, (${RETAINED_CONSUMER_ORIGINAL_SQL}) AS retained
          FROM generations g WHERE ${UNSAVED_SQL()} AND ${IN_WINDOW_SQL()} ORDER BY g.created_at DESC, g.id LIMIT ?`,
    args: [horizon, limit],
  });
  return rs.rows.map((r) => {
    let params: Record<string, unknown> = {};
    try { const parsed = JSON.parse(String(r.params ?? "{}")); if (parsed && typeof parsed === "object") params = parsed as Record<string, unknown>; } catch { /* an unreadable row classifies by its columns */ }
    return {
      id: String(r.id), kind: String(r.kind), provider: r.provider == null ? null : String(r.provider), model: String(r.model),
      arkTaskId: r.ark_task_id == null ? null : String(r.ark_task_id), params, retainedOriginal: Number(r.retained ?? 0) === 1, createdAt: Number(r.created_at),
    };
  });
}

/** Which of these takes now have a stored copy (a read: nothing is saved here). */
export async function storedAmong(ids: readonly string[]): Promise<Set<string>> {
  const stored = new Set<string>();
  await ready();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rs = await db().execute({ sql: `SELECT id FROM generations WHERE id IN (${chunk.map(() => "?").join(",")}) AND stored_url IS NOT NULL`, args: [...chunk] });
    for (const r of rs.rows) stored.add(String(r.id));
  }
  return stored;
}

/* ── One line per take per day ───────────────────────────────────────── */

const LOGGED_KEY = "atRiskUnsavableLogged";
const LOG_EVERY_MS = 24 * 3_600_000;
const LOGGED_MAX = 500;

/**
 * Logs one structured line for each take the heartbeat cannot save, at most once a day for each, and only while the take is at risk (a lost one stays quiet: nothing is at stake that
 * a line could change). Fields: the take id, kind, provider, a reason code and its age in hours. No prompt, no URL, no provider words. The last time each was logged is kept in
 * the workspace's own settings, pruned to the takes still unsavable, so a restart or a second server does not repeat a line. Returns the lines written.
 */
export async function logUnsavable(rows: readonly (AtRiskRow & { reason: UnsavableReason })[], at: number = Date.now()): Promise<number> {
  if (!rows.length) return 0;
  await ready();
  let logged: Record<string, number> = {};
  try {
    const rs = await db().execute({ sql: "SELECT value FROM settings WHERE key = ?", args: [LOGGED_KEY] });
    const parsed = rs.rows[0] ? JSON.parse(String(rs.rows[0].value)) : null;
    if (parsed && typeof parsed === "object") logged = parsed as Record<string, number>;
  } catch { /* none kept, or unreadable: every take is due */ }
  const next: Record<string, number> = {};
  const workspaceId = requireTenant().id;
  let written = 0;
  for (const row of rows.slice(0, LOGGED_MAX)) {
    const last = Number(logged[row.id]);
    if (Number.isFinite(last) && last > at - LOG_EVERY_MS) { next[row.id] = last; continue; }
    console.warn(JSON.stringify({ level: "warn", event: "reconciliation.at_risk_unsavable", workspaceId, id: row.id, kind: row.kind, provider: row.provider ?? "none", reason: row.reason, ageHours: Math.floor((at - row.createdAt) / 3_600_000) }));
    next[row.id] = at;
    written++;
  }
  try { await setSetting(LOGGED_KEY, JSON.stringify(next), "cron"); } catch { /* the lines are out; the next run may repeat them */ }
  return written;
}
