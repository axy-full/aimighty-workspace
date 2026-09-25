import { isGenjutsuModel } from "./genjutsuTypes";
import { isConsumerVideoModel, isConsumerOriginalParams } from "./higgsfield-consumer/original-identity";
import { reconcileGenjutsuVideo } from "./genjutsuVideo";
import {requireTenant} from './tenant';
import { withRecoveryJob } from './recovery';
import { db, ready, now } from "./db";
import { storeVideo } from "./storage";
import { inspectOriginalVideo } from "./videoMetadata.server";
import { costUsd, SOUL_CHARACTER_MODEL_ID } from "./models";
import { effectiveRate, estimateCostUsd } from "./vendorPricing";
import { creditsApply } from "./credits";
import { billCredits, marginKeyOf } from "./creditTerms";
import { currentTenant } from "./tenant";
import { reconcileFalRender } from "./identities";
import { syncFalVideo } from "./falVideo";
import { meter, type MeterEvent } from "./meter";
import {
  writeGenerationOutcome,
  deliverGenerationSettlement,
  flushGenerationSettlements,
  repairLegacyGenerationSettlements,
  generationCosts,
  type ReconcileResult,
} from "./generationSettlement";
import { TOPAZ_IMAGE_MODEL } from "./topaz";
import { loadJob, producedOutcome, seal, reconcileTopazImage, reconcileHiggsfieldImage } from "./renderWork";
import { restoreHiggsfieldGenerationReceipts, settleHiggsfieldGenerationReceipt } from "./higgsfieldGenerationReceipts";
import { retryRenderDispatches } from "./inngest";
import { billedTo, getProvider } from "./providers";
import { engineFor } from "./engines";
import { notify } from "./push";
import { hasRetainedConsumerOriginal, RETAINED_CONSUMER_ORIGINAL_SQL } from "./higgsfield-consumer/video-original";
import { uploadReservationsReady } from "./uploadReservations";
import type { AssetCursor } from "./assetPagination";
import type { ProviderCreditQuote } from "./providerCreditQuote";

export type Generation = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  arkTaskId: string | null;
  kind: "video" | "image" | "audio" | "model";
  reviewState: "" | "approved" | "picked" | "changes";
  reviewBy: string | null;
  pickedBy: string | null;
  pickedAt: number | null;
  approvedBy: string | null;
  approvedAt: number | null;
  model: string;
  prompt: string;
  /** The name the team gave it, if any — shown in place of the clip id. */
  title: string | null;
  params: Record<string, unknown>;
  status: string;
  sourceUrl: string | null;
  storedUrl: string | null;
  totalTokens: number | null;
  /** Dollars — only for a workspace that pays its vendors in them. */
  costUsd: number | null;
  /** Credits — only for a workspace that pays in them. Never both. */
  creditsBilled: number | null;
  providerCreditQuote?: ProviderCreditQuote | null;
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
  /** The stored original's own length in seconds (audio and video), when it could be read. */
  durationS: number | null;
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
  /* Read once per row rather than per field: which unit this workspace pays
     in decides what the row is allowed to carry. */
  const inCredits = creditsApply(currentTenant()?.workspace);
  const params = JSON.parse(r.params || "{}");
  const providerCreditQuote: ProviderCreditQuote | null =
    /^gen_hfc_[a-f0-9]{40}$/.test(r.id) && r.provider === "higgsfield" &&
    (isConsumerVideoModel(r.model) || isConsumerOriginalParams(params)) && r.status === "succeeded" &&
    params.consumerCreditUnit === "higgsfield_credits" &&
    typeof params.consumerCredits === "number" && Number.isFinite(params.consumerCredits) && params.consumerCredits >= 0
      ? { provider: "higgsfield", unit: "higgsfield_credits", credits: params.consumerCredits, basis: "approved_quote" }
      : null;
  // Queue recovery state contains vendor cost and storage internals, never UI input.
  delete params.producedOutcome;
  delete params.paidClaim;
  delete params.soulReferenceId;
  delete params.soulCredentialFingerprint;
  delete params.soulVendorCostUsd;
  delete params.higgsfieldCredentialFingerprint;
  delete params.higgsfieldVendorCostUsd;
  delete params.higgsfieldStillHandle;
  delete params.higgsfieldStillPollUntil;
  delete params.higgsfieldVideoHandle;
  delete params.higgsfieldVideoPollUntil;
  delete params.higgsfieldVideoPollToken;
  delete params.genjutsuOriginal;
  delete params.storeUntil;
  delete params.settledBy;
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    projectName: r.project_name ?? null,
    arkTaskId: r.ark_task_id ?? null,
    kind: r.kind === "image" ? "image" : r.kind === "audio" ? "audio" : r.kind === "model" ? "model" : "video",
    reviewState: r.review_state === "approved" ? "approved"
      : r.review_state === "picked" ? "picked"
      : r.review_state === "changes" ? "changes" : "",
    reviewBy: r.review_by ?? null,
    pickedBy: r.picked_by ?? null,
    pickedAt: r.picked_at == null ? null : Number(r.picked_at),
    approvedBy: r.approved_by ?? null,
    approvedAt: r.approved_at == null ? null : Number(r.approved_at),
    model: r.model,
    prompt: r.prompt,
    title: r.title ?? null,
    params,
    status: r.status,
    sourceUrl: r.source_url ?? null,
    storedUrl: r.stored_url ?? null,
    totalTokens: r.total_tokens ?? null,
    /* The unit this workspace pays in, and only that one.
       A workspace on the platform's keys is sent `creditsBilled` — the
       ledger's own figure, computed here where the margin lives — and NOT
       `cost_usd`, which is what the vendor charged the platform. Sending both
       was how the markup came to be a subtraction away on any take card. A
       workspace on its own keys gets the dollars, because those are the
       dollars that left its account. */
    costUsd: inCredits || providerCreditQuote ? null : (r.cost_usd ?? null),
    refineCostUsd: inCredits || providerCreditQuote ? null : (r.refine_cost_usd ?? null),
    providerCreditQuote,
    creditsBilled: inCredits && !providerCreditQuote
      ? billCredits(Number(r.cost_usd ?? 0) + Number(r.refine_cost_usd ?? 0), marginKeyOf(r.kind, r.model))
      : null,
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
    durationS: r.duration_s == null ? null : Number(r.duration_s),
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
  /** Server-resolved project library: filed takes plus explicitly linked draft references. */
  projectLibrary?: { productionProjectId: string; generationIds: string[] };
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
  /** Stable continuation for rows that share a created_at timestamp. */
  cursor?: AssetCursor | null;
  /** Read one extra row so a stable page can report whether more rows exist. */
  includeNext?: boolean;
  /** Only takes filed against no project — Make's wall and the Library's Unfiled lens (§10, §11). */
  unfiled?: boolean;
} = {}): Promise<Generation[]> {
  await ready();
  const where: string[] = [];
  const args: any[] = [];

  if (opts.projectLibrary) {
    where.push(`(g.project_id = ? OR g.id IN (SELECT value FROM json_each(?))
      OR g.id IN (SELECT j.atom FROM generations linked,json_tree(linked.params) j WHERE linked.project_id=? AND linked.deleted=0 AND j.key IN ('genId','generationId','sourceGenId','coverGenId')))`);
    args.push(opts.projectLibrary.productionProjectId, JSON.stringify(opts.projectLibrary.generationIds), opts.projectLibrary.productionProjectId);
  }

  if (opts.projectId !== undefined && opts.projectId !== null) {
    where.push("g.project_id = ?");
    args.push(opts.projectId);
  }
  if (opts.unfiled) where.push("g.project_id IS NULL");
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
    where.push(opts.kind === "image" ? "g.kind = 'image'" : opts.kind === "audio" ? "g.kind = 'audio'" : "g.kind NOT IN ('image','audio','model')");
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
  if (opts.cursor) {
    where.push("(g.created_at, g.id) < (?, ?)");
    args.push(opts.cursor.createdAt, opts.cursor.id);
  } else if (opts.before) {
    where.push("g.created_at < ?");
    args.push(opts.before);
  }

  where.push("g.deleted = 0");
  const sql = `${SELECT}
    WHERE ${where.join(" AND ")}
    ORDER BY g.created_at DESC, g.id DESC
    LIMIT ?`;
  args.push(Math.min(Math.max(opts.limit ?? 60, 1), 500) + (opts.includeNext ? 1 : 0));

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
/** Long enough for storeVideo's two-minute download budget, short enough to recover a crash. */
const STORE_LEASE_MS = 180_000;
/** A connected-account still sent with no acknowledgement: its receipt is written the moment the POST answers. */
const HIGGSFIELD_UNCONFIRMED_MS = 2 * 60 * 60_000;
/** A connected-account still whose polls have failed for a day will not be collected. */
const HIGGSFIELD_COLLECTION_MS = 24 * 60 * 60_000;

/**
 * Poll Ark for one generation and reconcile our row.
 * On first sight of success: copy the MP4 into our own storage and
 * snapshot the cost using the rate in effect right now.
 */
export async function syncGeneration(
  gen: Generation,
  options: { strict?: boolean } = {},
): Promise<Generation> {
  if (gen.status === "succeeded" && gen.provider === "higgsfield" && (isConsumerVideoModel(gen.model) || isConsumerOriginalParams(gen.params)) && gen.storedUrl && await hasRetainedConsumerOriginal(gen.id)) return gen;
return await withRecoveryJob(requireTenant().id, gen.id, async () => {

  await deliverGenerationSettlement(gen.id);
  if (gen.kind === "image" && gen.provider === "higgsfield") {
    try { await reconcileHiggsfieldImage(gen.id); } catch (error) { if (options.strict) throw error; }
    return (await getGeneration(gen.id)) ?? gen;
  }
  if (gen.kind === "video" && gen.provider === "higgsfield" && isGenjutsuModel(gen.model)) {
    try { await reconcileGenjutsuVideo(gen.id); } catch (error) { if (options.strict) throw error; }
    return (await getGeneration(gen.id)) ?? gen;
  }
  const savedCosts = await generationCosts(gen.id);
  // A succeeded row isn't final until the video is in our storage AND the
  // cost is recorded — Ark can report success a beat before usage appears,
  // and sealing early would make the clip permanently free in the ledger.
  if (
    TERMINAL.has(gen.status) &&
    (gen.status !== "succeeded" || (gen.storedUrl && savedCosts.cost != null))
  ) {
    return gen;
  }
  if (gen.kind === "image" && gen.model === TOPAZ_IMAGE_MODEL && gen.params.falStillRequestId) {
    try { await reconcileTopazImage(gen.id); } catch (error) { if (options.strict) throw error; }
    return (await getGeneration(gen.id)) ?? gen;
  }
  // fal video rows carry a request id, not an Ark task: their own sync.
  if (gen.provider === "fal" && gen.kind === "video")
    return syncFalVideo(gen, options);
  if (!gen.arkTaskId) return gen;

  let task;
  try {
    task = await engineFor(gen.provider ?? "byteplus").poll!({
      provider: "byteplus",
      ref: gen.arkTaskId,
      model: gen.model,
    });
  } catch (e) {
    // Transient poll failure: leave the row alone, report it upward.
    if (options.strict) throw e;
    return { ...gen, error: (e as Error).message };
  }

  let storedUrl = gen.storedUrl;
  let storeLease: number | null = null;
  try {
    let cost = savedCosts.cost;
    let storageFailed = false;
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
    /* The DELIVERED length of the clip we just stored, in seconds, which is the
       column every per-second tool prices from. `params.duration` is only what was
       ASKED for; a vendor that trims or pads a render makes the two differ, and the
       library has to carry the length of the file it actually holds. Measured from
       the stored bytes with the same bounded inspector the lazy backfill uses, so
       the first reframe/Shorts quote is a column read instead of a storage read. */
    let deliveredSeconds: number | null = null;
    if (
      task.vendorStartedAt &&
      task.vendorEndedAt &&
      task.vendorEndedAt >= task.vendorStartedAt
    ) {
      engineMs = task.vendorEndedAt - task.vendorStartedAt;
      noticeMs = Math.max(0, now() - task.vendorEndedAt);
    }

    if (task.status === "succeeded") {
      if (task.videoUrl && !storedUrl) {
        /* One download per master. Every open tab, teammate and the cron polls
           the same render; the first to see it finish holds a short lease and
           the rest leave it to them rather than pulling up to 200 MB again. */
        const lease = now() + STORE_LEASE_MS;
        const leased = await db().execute({
          sql: `UPDATE generations SET params=json_set(params,'$.storeUntil',?)
                WHERE id=? AND stored_url IS NULL AND COALESCE(json_extract(params,'$.storeUntil'),0) < ? RETURNING id`,
          args: [lease, gen.id, now()],
        });
        if (!leased.rows.length) return (await getGeneration(gen.id)) ?? gen;
        storeLease = lease;
        const storeStart = now();
        try {
          const put = await storeVideo(gen.id, task.videoUrl);
          storedUrl = put.url;
          storedBytes = put.bytes;
          storeMs = now() - storeStart;
          /* BEST EFFORT, and deliberately so: a length we cannot read is not a
             reason to unsettle a render that is safely stored and about to be
             billed. It leaves duration_s NULL exactly as before, and
             resolveStoredDuration measures it on first read instead. */
          try {
            const measured = await inspectOriginalVideo(
              { id: gen.id, kind: "video", role: "reference_video", mime: "video/mp4", ext: "mp4", storedUrl: put.url, fromGeneration: true },
              put.bytes,
            );
            if (Number.isFinite(measured.seconds) && measured.seconds > 0)
              deliveredSeconds = Math.round(measured.seconds * 1000) / 1000;
          } catch (e) {
            console.warn(`duration measurement failed for ${gen.id}:`, (e as Error).message);
          }
        } catch (e) {
          // Keep the (expiring) Ark URL as a fallback rather than losing the render.
          // Loud in the logs: a silent failure here cost us two near-lost videos.
          console.error(`storeVideo failed for ${gen.id}:`, (e as Error).message);
          storedUrl = null;
          storageFailed = true;
        }
      }
      // Snapshot the cost exactly ONCE — a storeVideo retry must not recompute
      // it at whatever the rate happens to be later; history stays truthful.
      /* Per-second engines that state their own charge (Grok Imagine Video):
         the vendor's figure when it is within half to three times the quote
         (xAI's tick unit is not published), else the quote itself. */
      if (cost == null && gen.provider === "xai") {
        const p = gen.params as { resolution?: string; ratio?: string; duration?: number };
        const quote = estimateCostUsd(gen.model, String(p.resolution ?? "720p"), String(p.ratio ?? "16:9"), Number(p.duration ?? 5), 0, false)?.net ?? null;
        const stated = task.costUsd;
        cost = quote != null && typeof stated === "number" && Number.isFinite(stated) && stated >= quote * 0.5 && stated <= quote * 3 ? stated : quote;
      }
      if (cost == null && task.totalTokens != null) {
        const p = gen.params as { resolution?: string; hasVideoInput?: boolean };
        rate = effectiveRate(
          gen.model,
          String(p.resolution ?? "720p"),
          Boolean(p.hasVideoInput),
        );
        cost = rate == null ? null : costUsd(task.totalTokens, rate);
      }
    }

    const ts = now();
    // How long the render actually took, recorded once when it reaches a
    // terminal state. Analytics reads this to answer "where do shots get
    // stuck" without having to guess from timestamps that keep moving.
    const durationMs = TERMINAL.has(task.status)
      ? Math.max(0, ts - gen.createdAt)
      : null;
    /* Which poller moved the row out of queued/running. SET reads the row as it
       was before the update, so only the one real transition writes its token;
       a repair write on an already-finished row leaves it alone. */
    const settledBy = `${ts}:${Math.random().toString(36).slice(2)}`;
    const outcomeWrite = {
      sql: `UPDATE generations
            SET status=?, source_url=?, stored_url=?, total_tokens=?,
                cost_usd=COALESCE(?, cost_usd),
                rate_usd_per_m=COALESCE(?, rate_usd_per_m),
                duration_ms=COALESCE(duration_ms, ?),
                engine_ms=COALESCE(?, engine_ms),
                notice_ms=COALESCE(?, notice_ms),
                store_ms=COALESCE(?, store_ms),
                bytes=COALESCE(?, bytes),
                duration_s=COALESCE(?, duration_s),
                params=CASE WHEN ? AND status IN ('queued','running') THEN json_set(params,'$.settledBy',?) ELSE params END,
                error=?, updated_at=?
            WHERE id=? AND (status IN ('queued','running') OR (?='succeeded' AND status!='cancelled'))`,
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
        deliveredSeconds,
        TERMINAL.has(task.status) ? 1 : 0,
        settledBy,
        task.error,
        ts,
        gen.id,
        task.status,
      ],
    };
    const event: MeterEvent = {
      id: gen.id,
      kind: "video",
      engine: billedTo(gen.provider),
      model: gen.model,
      status:
        task.status === "succeeded"
          ? "succeeded"
          : TERMINAL.has(task.status)
            ? "failed"
            : "running",
      /* Only a failure is known to be free. A success whose usage has not
         arrived yet keeps its reservation (null) until the cost is known;
         zeroing it here handed the credits back while the clip was delivered. */
      engineCostUsd:
        cost != null
          ? cost + savedCosts.refinement
          : task.status !== "succeeded" && TERMINAL.has(task.status) && !getProvider(gen.provider).billsFailures
            ? 0
            : null,
      durationMs,
      projectId: gen.projectId,
      shotId: gen.shotId,
    };
    if (TERMINAL.has(task.status)) {
      const changed = await writeGenerationOutcome(outcomeWrite, event);
      await deliverGenerationSettlement(gen.id);
      if (!changed) return (await getGeneration(gen.id)) ?? gen;
    } else {
      const changed = await db().execute(outcomeWrite);
      if (!changed.rowsAffected) return (await getGeneration(gen.id)) ?? gen;
      if (cost != null) await meter(event);
    }

    if (TERMINAL.has(task.status)) {
      /* A freed slot releases held takes from the settlement itself
         (lib/generationSettlement.ts), for every engine.
         The take is done, one way or the other: tell whoever asked for it, if
         they asked to be told (brief 2.7). Their own takes only — the wall is
         for watching everyone else's. Once: only the poll that moved the row
         sends it, never a second tab or the cron repairing it later. */
      const moved = gen.createdBy
        ? (await db().execute({ sql: "SELECT json_extract(params,'$.settledBy') AS by FROM generations WHERE id=?", args: [gen.id] })).rows[0]?.by === settledBy
        : false;
      if (gen.createdBy && moved) {
        const where = gen.shotCode
          ? `${gen.shotCode} v${gen.version ?? 1}`
          : "Your take";
        void notify(
          "takeDone",
          [gen.createdBy],
          task.status === "succeeded"
            ? {
                title: `${where} is ready`,
                body: gen.prompt.slice(0, 120),
                url: "/",
              }
            : {
                title: `${where} didn't render`,
                body: (task.error ?? "The engine refused it.").slice(0, 120),
                url: "/",
              },
        ).catch(() => {
          /* a take stands whether or not the nudge lands */
        });
      }
    }
    if (storageFailed && options.strict)
      throw new Error("The completed master could not be stored.");
    return {
      ...gen,
      status: task.status,
      sourceUrl: task.videoUrl,
      storedUrl,
      totalTokens: task.totalTokens,
      durationS: deliveredSeconds ?? gen.durationS,
      costUsd: creditsApply(currentTenant()?.workspace) ? null : cost,
      creditsBilled: creditsApply(currentTenant()?.workspace)
        ? billCredits(
            (cost ?? 0) + savedCosts.refinement,
            marginKeyOf(gen.kind, gen.model),
          )
        : null,
      error: task.error,
      updatedAt: ts,
    };
  } finally {
    if (storeLease != null)
      await db().execute({
        sql: "UPDATE generations SET params=json_remove(params,'$.storeUntil') WHERE id=? AND json_extract(params,'$.storeUntil')=?",
        args: [gen.id, storeLease],
      }).catch(() => {});
  }

});
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
export async function syncPending(
  limit = 30,
  options: { deadlineAt?: number } = {},
): Promise<ReconcileResult & { deferred: number }> {
  await ready();
  await uploadReservationsReady();
  const bounded = Math.max(1, Math.min(50, limit));
  const results = {
    ...(await flushGenerationSettlements(bounded)),
    deferred: 0,
  };
  const legacy = await repairLegacyGenerationSettlements(bounded);
  results.attempted += legacy.attempted;
  results.failed += legacy.failed;
  const soulReceipts = await restoreHiggsfieldGenerationReceipts(bounded);
  results.attempted += soulReceipts.attempted;
  results.failed += soulReceipts.failed;
  const dispatch = await retryRenderDispatches({
    limit: 4,
    deadlineAt: options.deadlineAt,
  });
  results.attempted += dispatch.attempted;
  results.failed += dispatch.failed;
  results.deferred += dispatch.deferred;
  const native = await (await import("./astra-blender/render-dispatch")).recoverAstraRenders({limit:4,deadlineAt:options.deadlineAt});
  results.attempted += native.attempted;
  results.failed += native.failed;
  results.deferred += native.deferred;
  // Dubbing projects: submit the queued, ask after the submitted, collect the finished. Never resubmit.
  const dubs = await (await import("./dubbing")).recoverDubbingJobs({ limit: 4, deadlineAt: options.deadlineAt });
  results.attempted += dubs.attempted;
  results.failed += dubs.failed;
  results.deferred += dubs.deferred;
  const horizon = now() - 3 * 86400_000;
  const rs = await db().execute({
    sql: `${SELECT} WHERE (g.status IN ('queued','running') AND g.deleted=0)
      OR (g.status='succeeded' AND g.deleted=0 AND g.created_at > ?
        AND (g.stored_url IS NULL OR g.cost_usd IS NULL) AND NOT (${RETAINED_CONSUMER_ORIGINAL_SQL}))
      ORDER BY g.updated_at,g.created_at,g.id LIMIT ?`,
    args: [horizon, bounded],
  });
  // Oldest checked first, with a persisted check time: failures cannot starve later jobs.
  for (let i = 0; i < rs.rows.length; i += 4) {
    if (options.deadlineAt != null && now() >= options.deadlineAt) {
      results.deferred += rs.rows.length - i;
      break;
    }
    const batch = await Promise.allSettled(
      rows(rs)
        .slice(i, i + 4)
        .map(async (row) => {
          await db().execute({
            sql: "UPDATE generations SET updated_at=? WHERE id=?",
            args: [now(), row.id],
          });
          const gen = rowToGeneration(row);
          const params = JSON.parse(String(row.params || "{}"));
          // A dubbing project's row is advanced by its own workflow above; it is neither a render nor an orphan.
          if (gen.kind === "audio" && params.task === "dub") return;
          if (
            (gen.kind === "image" || gen.kind === "audio") &&
            params.producedOutcome
          ) {
            const job = await loadJob(gen.id),
              out = await producedOutcome(gen.id);
            if (job && out) {
              await seal(job, out);
              return;
            }
          }
          if (
            gen.provider === "fal" &&
            gen.kind === "image" &&
            params.falRequestId
          ) {
            await reconcileFalRender(
              {
                id: gen.id,
                requestId: params.falRequestId,
                createdAt: gen.createdAt,
                seed: typeof params.seed === "number" ? params.seed : null,
              },
              { strict: true },
            );
            return;
          }
          /* A connected-account still that was sent but never collected: no
             acknowledgement after two hours (the POST was lost), or a day of
             polls that cannot reach it (the account was rotated). It stops
             holding a render slot and can be hidden. The charge stays — the
             request may well have been accepted — at its verified price when
             the handle is known, so its receipt settles and is not reopened. */
          if (gen.kind === "image" && gen.provider === "higgsfield" && params.paidClaim != null && !TERMINAL.has(gen.status)) {
            const handle = Boolean(params.higgsfieldStillHandle);
            const since = Number(params.paidClaim) || gen.createdAt;
            if (since < now() - (handle ? HIGGSFIELD_COLLECTION_MS : HIGGSFIELD_UNCONFIRMED_MS)) {
              const price = gen.model === SOUL_CHARACTER_MODEL_ID ? params.soulVendorCostUsd : params.higgsfieldVendorCostUsd;
              const known = handle && typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
              await writeGenerationOutcome(
                {
                  sql: `UPDATE generations SET status='failed',error=?,cost_usd=COALESCE(cost_usd,?),params=json_set(params,'$.outcomeUncertain',1),updated_at=?
                    WHERE id=? AND status IN ('queued','running') AND deleted=0`,
                  args: [
                    handle
                      ? "The connected account stopped answering about this request, so its result could not be collected. Its cost stays charged; it will not be sent again."
                      : "The connected account never confirmed this request. Its estimated cost stays charged; it will not be sent again.",
                    known, now(), gen.id,
                  ],
                },
                { id: gen.id, kind: "image", engine: billedTo(gen.provider), model: gen.model, status: "failed",
                  engineCostUsd: known, projectId: gen.projectId, shotId: gen.shotId },
              );
              await deliverGenerationSettlement(gen.id);
              await settleHiggsfieldGenerationReceipt(gen.id).catch(() => false);
              return;
            }
          }
          const orphan =
            !gen.arkTaskId &&
            !params.falRequestId &&
            !params.falStillRequestId &&
            !params.higgsfieldStillHandle &&
            !(gen.provider === "higgsfield" && params.paidClaim) &&
            (params.worker
              ? Math.max(gen.createdAt, Number(params.workerDispatchedAt) || 0)
              : gen.createdAt) <
              now() - (params.worker ? 2 * 60 * 60_000 : 15 * 60_000);
          const expired = Boolean(gen.arkTaskId && gen.createdAt < horizon);
          if ((orphan || expired) && !TERMINAL.has(gen.status)) {
            /* Every paid path (claimRender, the video submit's paidClaim) claims
               the row before a vendor is called. No claim and nothing produced
               proves nothing was sent: the take ends and its reservation is
               released. The guard is in the write, so a worker that claims it
               at this very moment keeps it. */
            const unsent = orphan && params.paidClaim == null && !params.producedOutcome;
            // An expired function/handle does not prove the vendor refunded anything.
            // Keep its reservation, end the execution slot, and retain the permanent paid claim.
            await writeGenerationOutcome(
              unsent
                ? {
                    sql: `UPDATE generations SET status='failed',error=?,cost_usd=0,updated_at=?
                WHERE id=? AND status IN ('queued','running') AND deleted=0
                  AND json_extract(params,'$.paidClaim') IS NULL AND json_extract(params,'$.producedOutcome') IS NULL
                  AND ark_task_id IS NULL AND json_extract(params,'$.falRequestId') IS NULL`,
                    args: ["This take never started, so nothing was charged. Generate it again.", now(), gen.id],
                  }
                : {
                    sql: `UPDATE generations SET status='failed',error=?,params=json_set(params,'$.outcomeUncertain',1),updated_at=?
            WHERE id=? AND status IN ('queued','running') AND deleted=0`,
                    args: [
                      "This attempt was interrupted after it was sent, and the provider never confirmed the outcome. Its estimated cost stays charged; it will not be sent again.",
                      now(),
                      gen.id,
                    ],
                  },
              {
                id: gen.id,
                // Retained connected-account originals are never queued here;
                // a 3D row cannot reach this path, so meter it as a still.
                kind: gen.kind === "model" ? "image" : gen.kind,
                engine: billedTo(gen.provider),
                model: gen.model,
                status: "failed",
                engineCostUsd: unsent ? 0 : null,
                projectId: gen.projectId,
                shotId: gen.shotId,
              },
            );
            await deliverGenerationSettlement(gen.id);
            return;
          }
          await syncGeneration(gen, { strict: true });
        }),
    );
    results.attempted += batch.length;
    results.failed += batch.filter((item) => item.status === "rejected").length;
  }
  return results;
}
