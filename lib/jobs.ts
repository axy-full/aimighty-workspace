import { db, ready, now } from "./db";
import { fetchTask } from "./ark";
import { storeVideo } from "./storage";
import { costUsd, effectiveRate } from "./models";
import { reconcileFalRender } from "./identities";

export type Generation = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  arkTaskId: string | null;
  kind: "video" | "image" | "audio";
  reviewState: "" | "approved" | "picked" | "changes";
  reviewBy: string | null;
  model: string;
  prompt: string;
  /** The name the team gave it, if any — shown in place of the clip id. */
  title: string | null;
  params: Record<string, unknown>;
  status: string;
  sourceUrl: string | null;
  storedUrl: string | null;
  totalTokens: number | null;
  costUsd: number | null;
  /** What the prompt writer charged for this render, and who it was. */
  refineCostUsd: number | null;
  refineModel: string | null;
  refineInTokens: number | null;
  refineOutTokens: number | null;
  error: string | null;
  createdBy: string;
  authorName: string | null;
  /** Which shot this is a take of, and which take. */
  shotId: string | null;
  shotCode: string | null;
  shotScene: string | null;
  shotTitle: string | null;
  version: number;
  /** Wall-clock time from submit to delivery — the basis for "where do we get stuck". */
  durationMs: number | null;
  provider: string;
  attempts: number;
  /** generate | edit | extend. */
  task: string;
  /** The render this one edits or extends. */
  sourceGenId: string | null;
  createdAt: number;
  updatedAt: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Run tasks a few at a time rather than all at once.
 *
 * The cron has 300 seconds and a job of work that includes downloading
 * masters up to 200 MB. Firing thirty of those in one Promise.allSettled
 * lets a single slow download own the whole window, and everything behind
 * it goes unreconciled until the next run.
 */
async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.allSettled(items.slice(i, i + size).map(fn));
  }
}

/** libsql rows, typed loosely at the one place we read them by hand. */
function rows(rs: { rows: unknown[] }): any[] { return rs.rows as any[]; }

export function rowToGeneration(r: any): Generation {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    projectName: r.project_name ?? null,
    arkTaskId: r.ark_task_id ?? null,
    kind: r.kind === "image" ? "image" : r.kind === "audio" ? "audio" : "video",
    reviewState: r.review_state === "approved" ? "approved"
      : r.review_state === "picked" ? "picked"
      : r.review_state === "changes" ? "changes" : "",
    reviewBy: r.review_by ?? null,
    model: r.model,
    prompt: r.prompt,
    title: r.title ?? null,
    params: JSON.parse(r.params || "{}"),
    status: r.status,
    sourceUrl: r.source_url ?? null,
    storedUrl: r.stored_url ?? null,
    totalTokens: r.total_tokens ?? null,
    costUsd: r.cost_usd ?? null,
    refineCostUsd: r.refine_cost_usd ?? null,
    refineModel: r.refine_model ?? null,
    refineInTokens: r.refine_in_tokens == null ? null : Number(r.refine_in_tokens),
    refineOutTokens: r.refine_out_tokens == null ? null : Number(r.refine_out_tokens),
    error: r.error ?? null,
    createdBy: r.created_by ?? "",
    authorName: r.author_name ?? null,
    shotId: r.shot_id ?? null,
    shotCode: r.shot_code ?? null,
    shotScene: r.shot_scene ?? null,
    shotTitle: r.shot_title ?? null,
    version: Number(r.version ?? 1),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    provider: r.provider ?? "byteplus",
    attempts: Number(r.attempts ?? 1),
    task: r.task ?? "generate",
    sourceGenId: r.source_gen_id ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const SELECT = `
  SELECT g.*, p.name AS project_name, u.name AS author_name,
         s.code AS shot_code, s.scene AS shot_scene, s.title AS shot_title
  FROM generations g
  LEFT JOIN projects p ON p.id = g.project_id
  LEFT JOIN users    u ON u.id = g.created_by
  LEFT JOIN shots    s ON s.id = g.shot_id
`;

export async function listGenerations(opts: {
  projectId?: string | null;
  createdBy?: string | null;
  limit?: number;
  search?: string;
  status?: string;
  kind?: string;
  /** Only renders made with this identity. */
  identityId?: string | null;
  /** Only renders that cited this cast member by name. */
  castName?: string | null;
  /** Cursor: return only rows OLDER than this created_at (keyset pagination). */
  before?: number | null;
} = {}): Promise<Generation[]> {
  await ready();
  const where: string[] = [];
  const args: any[] = [];

  if (opts.projectId !== undefined && opts.projectId !== null) {
    where.push("g.project_id = ?");
    args.push(opts.projectId);
  }
  if (opts.createdBy) {
    where.push("g.created_by = ?");
    args.push(opts.createdBy);
  }
  // Searching and filtering happen HERE, not in the browser: the client only
  // ever holds a page or two, so a client-side filter would quietly search
  // just the newest slice and swear the rest of the library doesn't exist.
  if (opts.search) {
    where.push("(LOWER(g.prompt) LIKE ? OR LOWER(COALESCE(g.title, '')) LIKE ?)");
    const needle = `%${opts.search.toLowerCase()}%`;
    args.push(needle, needle);
  }
  if (opts.status && opts.status !== "all") {
    where.push("g.status = ?");
    args.push(opts.status);
  }
  if (opts.kind === "image" || opts.kind === "video" || opts.kind === "audio") {
    where.push(opts.kind === "image" ? "g.kind = 'image'" : opts.kind === "audio" ? "g.kind = 'audio'" : "g.kind NOT IN ('image','audio')");
  }
  if (opts.identityId) {
    where.push("json_extract(g.params, '$.identity.id') = ?");
    args.push(opts.identityId);
  }
  /* params.cast is the array of names a prompt actually cited, written at
     render time. COALESCE keeps json_each from being handed a null path on
     the rows that cited nobody, which is most of them. */
  if (opts.castName) {
    where.push(
      "EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(g.params,'$.cast'), '[]')) WHERE value = ?)"
    );
    args.push(opts.castName);
  }
  if (opts.before) {
    where.push("g.created_at < ?");
    args.push(opts.before);
  }

  where.push("g.deleted = 0");
  const sql = `${SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY g.created_at DESC
    LIMIT ?`;
  args.push(Math.min(Math.max(opts.limit ?? 60, 1), 500));

  const rs = await db().execute({ sql, args });
  return rs.rows.map(rowToGeneration);
}

export async function getGeneration(genId: string): Promise<Generation | null> {
  await ready();
  const rs = await db().execute({
    sql: `${SELECT} WHERE g.id = ? AND g.deleted = 0 LIMIT 1`,
    args: [genId],
  });
  return rs.rows[0] ? rowToGeneration(rs.rows[0]) : null;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Poll Ark for one generation and reconcile our row.
 * On first sight of success: copy the MP4 into our own storage and
 * snapshot the cost using the rate in effect right now.
 */
export async function syncGeneration(gen: Generation): Promise<Generation> {
  // A succeeded row isn't final until the video is in our storage AND the
  // cost is recorded — Ark can report success a beat before usage appears,
  // and sealing early would make the clip permanently free in the ledger.
  if (
    TERMINAL.has(gen.status) &&
    (gen.status !== "succeeded" || (gen.storedUrl && gen.costUsd != null))
  ) {
    return gen;
  }
  if (!gen.arkTaskId) return gen;

  let task;
  try {
    task = await fetchTask(gen.arkTaskId);
  } catch (e) {
    // Transient poll failure: leave the row alone, report it upward.
    return { ...gen, error: (e as Error).message };
  }

  let storedUrl = gen.storedUrl;
  let cost = gen.costUsd;
  let rate: number | null = null;
  /* Where the tail of a video render actually goes. The vendor's own clock,
     when it gives one, is the only way to tell its working time apart from
     our waiting: everything else we can see is "how long until a poll
     noticed". storeMs is ours either way — it is the file coming down from
     ModelArk and going up to our storage, which happens between the vendor
     finishing and the tile flipping. */
  let engineMs: number | null = null;
  let noticeMs: number | null = null;
  let storeMs: number | null = null;
  /** How much of the store this render occupies — rent, not a one-off charge. */
  let storedBytes: number | null = null;
  if (task.vendorStartedAt && task.vendorEndedAt && task.vendorEndedAt >= task.vendorStartedAt) {
    engineMs = task.vendorEndedAt - task.vendorStartedAt;
    noticeMs = Math.max(0, now() - task.vendorEndedAt);
  }

  if (task.status === "succeeded") {
    if (task.videoUrl && !storedUrl) {
      const storeStart = now();
      try {
        const put = await storeVideo(gen.id, task.videoUrl);
        storedUrl = put.url;
        storedBytes = put.bytes;
        storeMs = now() - storeStart;
      } catch (e) {
        // Keep the (expiring) Ark URL as a fallback rather than losing the render.
        // Loud in the logs: a silent failure here cost us two near-lost videos.
        console.error(`storeVideo failed for ${gen.id}:`, (e as Error).message);
        storedUrl = null;
      }
    }
    // Snapshot the cost exactly ONCE — a storeVideo retry must not recompute
    // it at whatever the rate happens to be later; history stays truthful.
    if (cost == null && task.totalTokens != null) {
      const p = gen.params as { resolution?: string; hasVideoInput?: boolean };
      rate = effectiveRate(gen.model, String(p.resolution ?? "720p"), Boolean(p.hasVideoInput));
      cost = rate == null ? null : costUsd(task.totalTokens, rate);
    }
  }

  const ts = now();
  // How long the render actually took, recorded once when it reaches a
  // terminal state. Analytics reads this to answer "where do shots get
  // stuck" without having to guess from timestamps that keep moving.
  const durationMs = TERMINAL.has(task.status) ? Math.max(0, ts - gen.createdAt) : null;
  await db().execute({
    sql: `UPDATE generations
          SET status=?, source_url=?, stored_url=?, total_tokens=?,
              cost_usd=COALESCE(?, cost_usd),
              rate_usd_per_m=COALESCE(?, rate_usd_per_m),
              duration_ms=COALESCE(duration_ms, ?),
              engine_ms=COALESCE(?, engine_ms),
              notice_ms=COALESCE(?, notice_ms),
              store_ms=COALESCE(?, store_ms),
              bytes=COALESCE(?, bytes),
              error=?, updated_at=?
          WHERE id=?`,
    args: [
      task.status,
      task.videoUrl,
      storedUrl,
      task.totalTokens,
      cost,
      rate,
      durationMs,
      engineMs,
      noticeMs,
      storeMs,
      storedBytes,
      task.error,
      ts,
      gen.id,
    ],
  });

  return {
    ...gen,
    status: task.status,
    sourceUrl: task.videoUrl,
    storedUrl,
    totalTokens: task.totalTokens,
    costUsd: cost,
    error: task.error,
    updatedAt: ts,
  };
}

/**
 * The cheap sync for READ paths.
 *
 * Asks one indexed question — is anything actually in flight? — and does
 * nothing at all when the answer is no, which is almost always. Repairs and
 * janitorial work belong to the cron below, not to every list request: the
 * old version ran a write plus a wide scan on every poll from every open tab,
 * so a workspace that was merely *open* paid for reconciliation forever.
 */
export async function syncActive(limit = 12): Promise<void> {
  await ready();
  const rs = await db().execute({
    sql: `${SELECT} WHERE g.status IN ('queued','running') AND g.deleted = 0
          ORDER BY g.created_at DESC LIMIT ?`,
    args: [limit],
  });
  if (!rs.rows.length) return;
  await inChunks(rows(rs), 6, (r) => syncGeneration(rowToGeneration(r)));
}

/**
 * The thorough sync, for the 10-minute cron: in-flight jobs, plus repairs for
 * anything that finished but never landed in our storage or never recorded a
 * cost, plus the stuck-image janitor.
 */
export async function syncPending(limit = 30): Promise<void> {
  await ready();

  /* ── First, rescue what CAN be rescued ──────────────────────────────
   * fal keeps its jobs on a durable queue, and every render writes its
   * request id to the row before it starts waiting. So a render whose
   * function died is not lost: ask fal how it went and seal the row.
   * This has to run BEFORE the repair sweep below, or the sweep would
   * fail rows whose work is sitting finished at the vendor.
   * ---------------------------------------------------------------- */
  try {
    const falRows = await db().execute({
      sql: `SELECT id, params, created_at FROM generations
            WHERE provider='fal' AND status IN ('queued','running') AND deleted=0
              AND json_extract(params, '$.falRequestId') IS NOT NULL
            ORDER BY created_at DESC LIMIT ?`,
      args: [limit],
    });
    await inChunks(rows(falRows), 4, (r) => {
      let p: { falRequestId?: string; seed?: number } = {};
      try { p = JSON.parse(r.params || "{}"); } catch { /* unreadable params, no handle */ }
      if (!p.falRequestId) return Promise.resolve();
      return reconcileFalRender({
        id: r.id, requestId: p.falRequestId,
        createdAt: Number(r.created_at),
        seed: typeof p.seed === "number" ? p.seed : null,
      });
    });
  } catch (e) {
    console.error("fal reconcile failed:", (e as Error).message);
  }

  /* ── Then fail what cannot ──────────────────────────────────────────
   * Stills on Google and audio on ElevenLabs are synchronous: the bytes
   * come back inside our own after() callback, with no task and no queue
   * behind them. If such a row is still running long past the route's own
   * five-minute ceiling, the function died mid-call and nothing will ever
   * finish it. Fifteen minutes is the horizon — comfortably beyond any
   * live work, so this can never kill a render that is still going.
   * A fal row that never got as far as a request id belongs here too.
   * ---------------------------------------------------------------- */
  await db().execute({
    sql: `UPDATE generations
          SET status='failed',
              error='The call was interrupted before it finished — render again.',
              updated_at=?
          WHERE status IN ('queued','running')
            AND deleted = 0
            AND ark_task_id IS NULL
            AND json_extract(params, '$.falRequestId') IS NULL
            AND json_extract(params, '$.worker') IS NULL
            AND created_at < ?`,
    args: [now(), now() - 15 * 60_000],
  });

  /* ── The backstop for rows the worker owns ──────────────────────────
   * A render handed to Inngest is exempt from the sweep above, and rightly:
   * Inngest retries with its own backoff, which can run well past fifteen
   * minutes, and killing a row mid-retry would abandon work it is about to
   * finish. Inngest is also what ENDS such a row — its onFailure writes the
   * failure once the retries are spent.
   *
   * This exists only for the case where Inngest never comes back at all: the
   * app unregistered, the account gone, the event lost before delivery. Two
   * hours is far beyond any real retry schedule, so it can only catch a row
   * nobody is coming for.
   * ------------------------------------------------------------------ */
  await db().execute({
    sql: `UPDATE generations
          SET status='failed',
              error='The worker never picked this up. Nothing was delivered — render again.',
              updated_at=?
          WHERE status IN ('queued','running')
            AND deleted = 0
            AND ark_task_id IS NULL
            AND json_extract(params, '$.falRequestId') IS NULL
            AND json_extract(params, '$.worker') IS NOT NULL
            AND created_at < ?`,
    args: [now(), now() - 2 * 60 * 60_000],
  });

  // Repair clauses only look back 3 days: past that, Ark's task and URL are
  // long gone (48h expiry) and re-polling a dead task forever is just noise.
  const horizon = now() - 3 * 86400_000;

  /* ── And the video rows whose task ModelArk has since forgotten ──────
   * The horizon above bounds only the second clause of the sweep below;
   * the first one — anything not yet terminal — had no age bound at all,
   * so a row whose task record expired was re-polled for ever and never
   * reached a terminal state. Three days is deliberately generous: the
   * poll itself has a 30s deadline and a single ModelArk 502 must never
   * be mistaken for an expired task and kill a live, already-paid render.
   * ------------------------------------------------------------------ */
  await db().execute({
    sql: `UPDATE generations
          SET status='failed',
              error='ModelArk no longer has this task — its record expired before the result could be read. Render again.',
              updated_at=?
          WHERE status IN ('queued','running')
            AND deleted = 0
            AND ark_task_id IS NOT NULL
            AND created_at < ?`,
    args: [now(), horizon],
  });
  const rs = await db().execute({
    sql: `${SELECT} WHERE (g.status NOT IN ('succeeded','failed','cancelled') AND g.deleted=0)
             OR (g.status='succeeded' AND g.deleted=0 AND g.created_at > ?
                 AND (g.stored_url IS NULL OR g.cost_usd IS NULL))
          ORDER BY g.created_at DESC LIMIT ?`,
    args: [horizon, limit],
  });
  await inChunks(rows(rs), 4, (r) => syncGeneration(rowToGeneration(r)));
}
