import { db, ready, now, id as newId } from "./db";
import { falConfigured, falSubmit, falStatus, falResult, falAwait, progressFromLogs } from "./fal";
import { readUploadBytes, storeIdentityZip, storeImageBytes, presignedReadUrl, usingBlob } from "./storage";
import { nameProblem } from "./cast";
import { invalidate, PROJECTS_KEY } from "./cache";
import { withRetry, getProvider } from "./providers";
import { meter, refuseIfPaused } from "./meter";
import { enginePausedFrom } from "./platformLayer";
import { fetchBytes } from "./mockFs";

/**
 * Identities — a real face, learned.
 *
 * A cast character holds one still and the engines are asked to keep faith
 * with it. An identity goes further, the way Higgsfield's Soul ID does: a
 * set of photos is handed to a trainer, which returns a small model of that
 * one face; every render made with it afterwards carries the face itself,
 * not a description of it. The photos stay in our store untouched; the
 * trainer gets a signed link to a zip that expires.
 *
 * When training finishes the identity also joins the cast, so @Name works
 * in Seedance prompts through the reference path the cast already uses.
 */

export type IdentityStatus = "draft" | "training" | "ready" | "failed";

export type Identity = {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  photos: string[];
  status: IdentityStatus;
  provider: string;
  trainer: string | null;
  requestId: string | null;
  trigger: string | null;
  steps: number | null;
  loraUrl: string | null;
  configUrl: string | null;
  costUsd: number | null;
  error: string | null;
  coverUploadId: string | null;
  castId: string | null;
  createdBy: string;
  authorName: string | null;
  createdAt: number;
  updatedAt: number;
  trainedAt: number | null;
  /** Who confirmed they have the right to train on this face, and when (brief 1.3). */
  consentBy: string | null;
  consentAt: number | null;
};

/* ── The trainer and its terms ─────────────────────────────────────── */

/** fal's portrait trainer — built for faces; the general one is the fallback. */
export const TRAINER = process.env.FAL_TRAINER ?? "fal-ai/flux-lora-portrait-trainer";
export const RENDERER = "fal-ai/flux-lora";
export const MIN_PHOTOS = 5;
export const MAX_PHOTOS = 40;
export const RECOMMENDED_PHOTOS = "10 to 20";
/** Steps decide both quality and price. fal's default is 2500; 1500 is the
 *  point past which a face stops improving noticeably. */
export const TRAIN_STEPS = Math.max(500, Math.min(5000, Number(process.env.FAL_TRAIN_STEPS ?? 1500)));
/** fal's listed price for the portrait trainer (read 2026-09-03):
 *  "$0.0024 per step. A minimum of 1000 steps will be billed." */
export const TRAIN_USD_PER_STEP = Number(process.env.FAL_TRAIN_USD_PER_STEP ?? 0.0024);
export const TRAIN_MIN_BILLED_STEPS = 1000;
/** How long a training job may sit unfinished before we call it lost. A
 *  1500-step portrait LoRA runs in tens of minutes; three hours means the
 *  job is gone, and an identity must not read "training" for ever. */
export const TRAIN_CEILING_MS = 3 * 60 * 60_000;
/** The same idea for a render, which takes seconds rather than minutes. */
export const RENDER_CEILING_MS = 30 * 60_000;
/** And a much longer one for when we cannot even ASK how a render went —
 *  fal unreachable, or the key withdrawn. A job that is demonstrably still
 *  queued may be abandoned after half an hour; one we simply cannot see is
 *  given hours, because giving up early would throw away the record of a
 *  render fal may have finished and billed. */
export const RENDER_UNREACHABLE_CEILING_MS = 6 * 60 * 60_000;

/** Rendering with a LoRA: "$0.035 per megapixel", rounded UP to the megapixel. */
export const RENDER_USD_PER_MP = Number(process.env.FAL_RENDER_USD_PER_MP ?? 0.035);

export const trainCostUsd = (steps = TRAIN_STEPS) =>
  Math.round(Math.max(steps, TRAIN_MIN_BILLED_STEPS) * TRAIN_USD_PER_STEP * 100) / 100;

/* eslint-disable @typescript-eslint/no-explicit-any */
export function rowToIdentity(r: any): Identity {
  let photos: string[] = [];
  try { photos = JSON.parse(r.photos || "[]"); } catch { photos = []; }
  const status = (["draft", "training", "ready", "failed"] as const).includes(r.status) ? r.status : "draft";
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    name: r.name,
    description: r.description ?? "",
    photos,
    status,
    provider: r.provider ?? "fal",
    trainer: r.trainer ?? null,
    requestId: r.request_id ?? null,
    trigger: r.trigger ?? null,
    steps: r.steps == null ? null : Number(r.steps),
    loraUrl: r.lora_url ?? null,
    configUrl: r.config_url ?? null,
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    error: r.error ?? null,
    coverUploadId: r.cover_upload_id ?? null,
    castId: r.cast_id ?? null,
    createdBy: r.created_by ?? "",
    authorName: r.author_name ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    trainedAt: r.trained_at == null ? null : Number(r.trained_at),
    consentBy: r.consent_by ?? null,
    consentAt: r.consent_at == null ? null : Number(r.consent_at),
  };
}

const SELECT = `SELECT i.*, u.name AS author_name FROM identities i LEFT JOIN users u ON u.id = i.created_by`;

export async function listIdentities(projectId?: string | null): Promise<Identity[]> {
  await ready();
  const rs = projectId
    ? await db().execute({ sql: `${SELECT} WHERE i.project_id = ? OR i.project_id IS NULL ORDER BY i.created_at DESC`, args: [projectId] })
    : await db().execute(`${SELECT} ORDER BY i.created_at DESC`);
  return rs.rows.map(rowToIdentity);
}

export async function getIdentity(id: string): Promise<Identity | null> {
  await ready();
  const rs = await db().execute({ sql: `${SELECT} WHERE i.id = ? LIMIT 1`, args: [id] });
  return rs.rows[0] ? rowToIdentity(rs.rows[0]) : null;
}

/** The word the trainer learns the face under. Rare on purpose — a real
 *  word would drag its own meaning into every render. */
export function triggerFor(name: string): string {
  return `pcl${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

export async function createIdentity(input: {
  name: string; description: string; photos: string[]; projectId: string | null; userId: string;
}): Promise<Identity> {
  await ready();
  const problem = nameProblem(input.name);
  if (problem) throw new Error(problem);
  const clash = await db().execute({
    sql: `SELECT id FROM identities WHERE LOWER(name) = LOWER(?) AND (project_id IS ? OR project_id IS NULL OR ? IS NULL) LIMIT 1`,
    args: [input.name.trim(), input.projectId, input.projectId],
  });
  if (clash.rows.length) throw new Error(`There is already an identity called ${input.name.trim()}.`);
  const cast = await db().execute({
    sql: `SELECT id FROM cast_members WHERE LOWER(name) = LOWER(?) LIMIT 1`, args: [input.name.trim()],
  });
  if (cast.rows.length) throw new Error(`@${input.name.trim()} is already in the cast — pick another name, or remove them first.`);
  const photos = await verifiedPhotos(input.photos);
  const id = newId("idn");
  const ts = now();
  await db().execute({
    sql: `INSERT INTO identities (id, project_id, name, description, photos, status, provider, cover_upload_id, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,'draft','fal',?,?,?,?)`,
    args: [id, input.projectId, input.name.trim(), input.description.trim().slice(0, 400), JSON.stringify(photos), photos[0] ?? null, input.userId, ts, ts],
  });
  return (await getIdentity(id))!;
}

/** Only image uploads that exist, in the order given, capped. */
async function verifiedPhotos(ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids.filter((x) => typeof x === "string" && /^[A-Za-z0-9_-]+$/.test(x)))].slice(0, MAX_PHOTOS);
  if (!wanted.length) return [];
  const rs = await db().execute({
    sql: `SELECT id FROM uploads WHERE id IN (${wanted.map(() => "?").join(",")}) AND kind='image'`,
    args: wanted,
  });
  const ok = new Set(rs.rows.map((r: any) => r.id as string));
  return wanted.filter((x) => ok.has(x));
}

export async function updateIdentity(id: string, patch: {
  name?: string; description?: string; photos?: string[]; coverUploadId?: string | null;
}): Promise<Identity> {
  const cur = await getIdentity(id);
  if (!cur) throw new Error("No such identity.");
  if (cur.status === "training") throw new Error("It's training — wait for it to finish before changing it.");
  const sets: string[] = []; const args: any[] = [];
  if (patch.name !== undefined) {
    const problem = nameProblem(patch.name); if (problem) throw new Error(problem);
    sets.push("name=?"); args.push(patch.name.trim());
  }
  if (patch.description !== undefined) { sets.push("description=?"); args.push(patch.description.trim().slice(0, 400)); }
  if (patch.photos !== undefined) {
    const photos = await verifiedPhotos(patch.photos);
    sets.push("photos=?"); args.push(JSON.stringify(photos));
    // Photos changed under a trained model: the model is now of a different set.
    if (cur.status === "ready" && JSON.stringify(photos) !== JSON.stringify(cur.photos)) {
      sets.push("status='draft'", "lora_url=NULL", "config_url=NULL", "trained_at=NULL");
    }
    if (patch.coverUploadId === undefined && (!cur.coverUploadId || !photos.includes(cur.coverUploadId))) {
      sets.push("cover_upload_id=?"); args.push(photos[0] ?? null);
    }
  }
  if (patch.coverUploadId !== undefined) { sets.push("cover_upload_id=?"); args.push(patch.coverUploadId); }
  if (!sets.length) return cur;
  sets.push("updated_at=?"); args.push(now(), id);
  await db().execute({ sql: `UPDATE identities SET ${sets.join(", ")} WHERE id=?`, args });
  return (await getIdentity(id))!;
}

export async function deleteIdentity(id: string): Promise<void> {
  await ready();
  await db().execute({ sql: `DELETE FROM identities WHERE id=?`, args: [id] });
}

/* ── Training ──────────────────────────────────────────────────────── */

/** The zip the trainer learns from: the originals, byte for byte. */
async function buildTrainingZip(identity: Identity): Promise<Buffer> {
  const rs = await db().execute({
    sql: `SELECT id, ext, stored_url FROM uploads WHERE id IN (${identity.photos.map(() => "?").join(",")})`,
    args: identity.photos,
  });
  const rows = new Map((rs.rows as any[]).map((r) => [r.id as string, r]));
  const files: Record<string, Uint8Array> = {};
  let n = 0;
  for (const pid of identity.photos) {
    const r = rows.get(pid);
    if (!r) continue;
    const bytes = await readUploadBytes(pid, r.ext, r.stored_url);
    n++;
    files[`${String(n).padStart(2, "0")}.${r.ext}`] = new Uint8Array(bytes);
  }
  if (n < MIN_PHOTOS) throw new Error(`Training needs at least ${MIN_PHOTOS} photos (${n} usable).`);
  const { zipSync } = await import("fflate");
  // Photos are already compressed; level 0 keeps the zip a plain container.
  return Buffer.from(zipSync(files, { level: 0 }));
}

export async function startTraining(id: string, consent?: { by: string }): Promise<Identity> {
  const identity = await getIdentity(id);
  if (!identity) throw new Error("No such identity.");
  if (!falConfigured()) {
    throw new Error("Identity training isn't connected for this workspace. Ask the platform to connect it.");
  }
  /* The kill switch (SOW v2 §9), read before the zip: the cheap early door.
     The one that binds is the running meter row below, written BEFORE fal
     holds a request, so a pause landing during the zip and the upload
     refuses before any money starts. */
  await refuseIfPaused(TRAINER, "fal");
  if (identity.status === "training") throw new Error("It's already training.");
  // The person pressing Train confirms the right to train on this face; it is stored with the identity.
  if (!consent?.by && !identity.consentAt) throw new Error("Confirm you have the right to train on this person's face.");
  if (identity.photos.length < MIN_PHOTOS) {
    throw new Error(`Add at least ${MIN_PHOTOS} photos first — ${RECOMMENDED_PHOTOS} is the sweet spot.`);
  }
  if (!usingBlob()) {
    throw new Error("Training needs the deployed store: the trainer fetches the photos from a signed link, which local files can't provide.");
  }
  const zip = await buildTrainingZip(identity);
  const pathname = await storeIdentityZip(identity.id, zip);
  const imagesUrl = await presignedReadUrl(pathname, 24);
  const trigger = identity.trigger ?? triggerFor(identity.name);
  /* The switch and the bill, where the money starts: the running row (and the
     gate inside meter()) is written before fal holds a request; a submit that
     fails is metered failed at cost 0 so the row never bills. */
  await meter({ id: identity.id, kind: "training", engine: "fal", model: TRAINER, status: "running",
                engineCostUsd: trainCostUsd(TRAIN_STEPS), projectId: identity.projectId });
  let queued: Awaited<ReturnType<typeof falSubmit>>;
  try {
    queued = await falSubmit(TRAINER, {
      images_data_url: imagesUrl,
      trigger_phrase: trigger,
      steps: TRAIN_STEPS,
      multiresolution_training: true,
      subject_crop: true,
      create_masks: false,
    });
  } catch (e) {
    await meter({ id: identity.id, kind: "training", engine: "fal", model: TRAINER, status: "failed",
                  engineCostUsd: 0, projectId: identity.projectId }, { critical: false }).catch(() => {});
    throw e;
  }
  await db().execute({
    sql: `UPDATE identities SET status='training', trainer=?, request_id=?, trigger=?, steps=?, cost_usd=?, error=NULL,
                                consent_by=COALESCE(?, consent_by), consent_at=COALESCE(consent_at, ?), updated_at=? WHERE id=?`,
    args: [TRAINER, queued.request_id, trigger, TRAIN_STEPS, trainCostUsd(TRAIN_STEPS), consent?.by ?? null, now(), now(), identity.id],
  });
  return (await getIdentity(identity.id))!;
}

type TrainResult = {
  diffusers_lora_file?: { url: string; file_name?: string; file_size?: number };
  config_file?: { url: string };
};

/**
 * Ask the trainer how it's going. Returns the identity and, while it trains,
 * a percentage read off the trainer's own log. When it's done the model's
 * URL is written down and the identity joins the cast.
 */
export async function syncIdentity(identity: Identity): Promise<{ identity: Identity; progress: number | null }> {
  if (identity.status !== "training" || !identity.requestId || !identity.trainer) return { identity, progress: null };
  let st;
  try {
    st = await falStatus(identity.trainer, identity.requestId, true);
  } catch (e) {
    // A status call failing is weather, not a verdict — unless the key is gone.
    const msg = (e as Error).message;
    if (/rejected the key/.test(msg)) await markFailed(identity.id, msg);
    return { identity: (await getIdentity(identity.id))!, progress: null };
  }
  if (st.status !== "COMPLETED") {
    // A job fal has forgotten would otherwise leave this identity reading
    // "training" for good, with no way for anyone to clear it.
    const since = identity.updatedAt || identity.createdAt;
    if (now() - since > TRAIN_CEILING_MS) {
      await markFailed(identity.id,
        "The trainer never finished. Nothing usable came back, so train again — " +
        "fal only bills for a completed run.");
      return { identity: (await getIdentity(identity.id))!, progress: null };
    }
    return { identity, progress: progressFromLogs(st.logs) };
  }
  try {
    const out = await falResult<TrainResult>(identity.trainer, identity.requestId);
    const lora = out.diffusers_lora_file?.url;
    if (!lora) throw new Error("The trainer finished without returning a model file.");
    const castId = await joinCast(identity);
    await db().execute({
      sql: `UPDATE identities SET status='ready', lora_url=?, config_url=?, cast_id=?, trained_at=?, updated_at=?, error=NULL WHERE id=?`,
      args: [lora, out.config_file?.url ?? null, castId, now(), now(), identity.id],
    });
    await meter({ id: identity.id, kind: "training", engine: "fal", model: TRAINER, status: "succeeded", projectId: identity.projectId }, { critical: false });
  } catch (e) {
    await markFailed(identity.id, (e as Error).message);
  }
  return { identity: (await getIdentity(identity.id))!, progress: 100 };
}

async function markFailed(id: string, error: string): Promise<void> {
  await db().execute({
    sql: `UPDATE identities SET status='failed', error=?, updated_at=? WHERE id=?`,
    args: [error.slice(0, 600), now(), id],
  });
  await meter({ id, kind: "training", engine: "fal", model: TRAINER, status: "failed",
                engineCostUsd: getProvider("fal").billsFailures ? null : 0 }, { critical: false }).catch(() => {});
}

/** A trained identity is also a cast character, so @Name works everywhere. */
async function joinCast(identity: Identity): Promise<string | null> {
  if (identity.castId) {
    const have = await db().execute({ sql: `SELECT id FROM cast_members WHERE id=?`, args: [identity.castId] });
    if (have.rows.length) return identity.castId;
  }
  const clash = await db().execute({ sql: `SELECT id FROM cast_members WHERE LOWER(name)=LOWER(?) LIMIT 1`, args: [identity.name] });
  if (clash.rows.length) return clash.rows[0].id as string;
  const cid = newId("cast");
  await db().execute({
    sql: `INSERT INTO cast_members (id, project_id, name, kind, description, upload_id, created_by, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [cid, identity.projectId, identity.name, "character", identity.description, identity.coverUploadId ?? identity.photos[0] ?? null, identity.createdBy, now()],
  });
  return cid;
}

/** For the cron: every identity still training gets a look. */
export async function syncTrainingIdentities(limit = 10): Promise<void> {
  await ready();
  const rs = await db().execute({
    sql: `${SELECT} WHERE i.status='training' ORDER BY i.updated_at ASC LIMIT ?`, args: [limit],
  });
  await Promise.allSettled(rs.rows.map((r) => syncIdentity(rowToIdentity(r))));
}

/* ── Rendering ─────────────────────────────────────────────────────── */

export const RENDER_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

function imageSizeFor(ratio: string): string {
  return ({
    "1:1": "square_hd", "16:9": "landscape_16_9", "9:16": "portrait_16_9",
    "4:3": "landscape_4_3", "3:4": "portrait_4_3",
  } as Record<string, string>)[ratio] ?? "landscape_16_9";
}

/** The prompt the renderer sees: @Name becomes the trigger; a prompt that
 *  never mentions them gets the trigger up front, where Flux weights it. */
export function promptWithTrigger(prompt: string, identity: Identity): string {
  const trigger = identity.trigger ?? triggerFor(identity.name);
  const cited = prompt.replace(new RegExp(`@${identity.name}\\b`, "gi"), trigger);
  if (cited.toLowerCase().includes(trigger)) return cited.trim();
  return `${trigger}, ${cited.trim()}`;
}

type RenderResult = {
  images: { url: string; width?: number; height?: number; content_type?: string }[];
  seed?: number;
  has_nsfw_concepts?: boolean[];
};

/** The exact body fal is asked to render. Kept in one place so a resumed
 *  render and a fresh one can never drift apart. */
function renderInput(identity: Identity, opts: { prompt: string; ratio: string; seed: number | null }) {
  return {
    prompt: opts.prompt,
    loras: [{ path: identity.loraUrl, scale: 1 }],
    image_size: imageSizeFor(opts.ratio),
    num_images: 1,
    num_inference_steps: 28,
    guidance_scale: 3.5,
    output_format: "png",
    enable_safety_checker: true,
    ...(opts.seed != null ? { seed: opts.seed } : {}),
  };
}

/**
 * fal looked at the job and said no — a safety refusal, or a result with no
 * image in it. Distinct from every transport failure, because a refusal is
 * final and retrying it just spends the clock.
 */
class RenderRefused extends Error {}

async function failRender(genId: string, message: string, startedAt: number): Promise<void> {
  await db().execute({
    sql: `UPDATE generations SET status='failed', error=?, duration_ms=?, updated_at=? WHERE id=?`,
    args: [message.slice(0, 600), Math.max(0, now() - startedAt), now(), genId],
  }).catch(() => {});
  await meter({ id: genId, kind: "image", engine: "fal", model: RENDERER, status: "failed",
                engineCostUsd: getProvider("fal").billsFailures ? null : 0, durationMs: Math.max(0, now() - startedAt) }, { critical: false }).catch(() => {});
  invalidate(PROJECTS_KEY);
}

/**
 * Take a finished fal result and seal the row: fetch the image, store it,
 * price it. Shared by the live path and by the cron's recovery, so a render
 * rescued an hour later is recorded exactly like one that never stumbled.
 */
async function finishRender(genId: string, out: RenderResult, startedAt: number, seed: number | null): Promise<void> {
  const img = out.images?.[0];
  if (!img?.url) throw new RenderRefused("fal.ai returned no image.");
  if (out.has_nsfw_concepts?.[0]) throw new RenderRefused("The safety checker flagged this render. Reword the prompt.");
  let bytes = await fetchBytes(img.url);
  const sharp = (await import("sharp")).default;
  const meta = await sharp(bytes).metadata();
  // The library keeps PNG. A JPEG from the vendor is decoded once, losslessly.
  if (meta.format !== "png") bytes = await sharp(bytes).png().toBuffer();
  // fal has already rendered and billed this. A Blob blip must not be the
  // thing that loses it; the put is idempotent, so trying again is free.
  const { value: stored } = await withRetry(() => storeImageBytes(genId, bytes), { max: 3 });
  const mp = ((img.width ?? meta.width ?? 1024) * (img.height ?? meta.height ?? 1024)) / 1_000_000;
  const cost = Math.round(Math.max(1, Math.ceil(mp)) * RENDER_USD_PER_MP * 10_000) / 10_000;
  await db().execute({
    sql: `UPDATE generations
          SET status='succeeded', stored_url=?, cost_usd=?, error=NULL, duration_ms=?, bytes=?,
              params=json_set(params, '$.seed', ?, '$.width', ?, '$.height', ?), updated_at=?
          WHERE id=?`,
    args: [stored.url, cost, Math.max(0, now() - startedAt), stored.bytes, out.seed ?? seed ?? null,
           img.width ?? meta.width ?? null, img.height ?? meta.height ?? null, now(), genId],
  });
  await meter({ id: genId, kind: "image", engine: "fal", model: RENDERER, status: "succeeded", engineCostUsd: cost, durationMs: Math.max(0, now() - startedAt) }, { critical: false });
  invalidate(PROJECTS_KEY);
}

/**
 * One render, on a row that already exists as "running". Runs after the
 * response has gone out.
 *
 * The submit and the wait are deliberately separate. fal holds the job on
 * its own queue, so the moment we have a request id we write it to the row —
 * and from then on the work is recoverable. If this instance is reclaimed
 * mid-wait (a deploy, a timeout, a reaped container), the cron finds the row
 * by that id and finishes the render fal has already done and charged for.
 * It is the same trick that makes the video path durable, where ModelArk
 * holds the task.
 */
export async function runIdentityRender(genId: string, identity: Identity, opts: {
  prompt: string; ratio: string; seed: number | null; startedAt: number;
}): Promise<void> {
  let handle: string | null = null;
  try {
    if (!identity.loraUrl) throw new Error("This identity has no trained model yet.");
    const queued = await falSubmit(RENDERER, renderInput(identity, opts));
    handle = queued.request_id;
    // Written down BEFORE the wait: this is the whole point.
    await db().execute({
      sql: `UPDATE generations SET params=json_set(params, '$.falRequestId', ?), updated_at=? WHERE id=?`,
      args: [queued.request_id, now(), genId],
    });
    const out = await falAwait<RenderResult>(RENDERER, queued.request_id);
    await finishRender(genId, out, opts.startedAt, opts.seed);
  } catch (e) {
    const err = e as Error;
    /* Once fal has the job, a failure HERE is almost always our side of the
       wire: the wait ran long, the image URL blipped, the instance is being
       torn down. Binning the row would throw away a render fal has finished
       and charged for. So leave it running and let the cron finish it from
       the request id — the ceilings in reconcileFalRender stop it spinning
       for ever. Only a refusal, which no amount of asking again will change,
       ends the render here. */
    if (handle && !(err instanceof RenderRefused)) {
      console.error(`identity render ${genId} interrupted; left for the cron:`, err.message);
      return;
    }
    await failRender(genId, err.message, opts.startedAt);
  }
}

/**
 * Pick up a render whose function died after the job was submitted.
 *
 * Called by the cron for any fal row still running that carries a request id.
 * Anything genuinely still working is left alone; it only gives up once the
 * job has had far longer than a real render could need.
 */
export async function reconcileFalRender(row: {
  id: string; requestId: string; createdAt: number; seed: number | null;
}): Promise<void> {
  let st;
  try {
    st = await falStatus(RENDERER, row.requestId);
  } catch (e) {
    const msg = (e as Error).message;
    // A job fal no longer knows about is never coming back.
    if (/\b404\b|not found/i.test(msg)) {
      await failRender(row.id, "fal.ai no longer has this job. Render again.", row.createdAt);
      return;
    }
    // Anything else is weather, and the next run of the cron asks again —
    // but not for ever. A row nobody can ever get an answer about would
    // otherwise spin on the wall until someone deleted it by hand.
    if (now() - row.createdAt > RENDER_UNREACHABLE_CEILING_MS) {
      await failRender(row.id,
        `Could not reach fal.ai to find out how this render went: ${msg} ` +
        "If it did complete, fal will still have charged for it.", row.createdAt);
    }
    return;
  }
  if (st.status !== "COMPLETED") {
    if (now() - row.createdAt > RENDER_CEILING_MS) {
      await failRender(row.id, "The render never came back from fal.ai. Render again.", row.createdAt);
    }
    return;
  }
  try {
    const out = await falResult<RenderResult>(RENDERER, row.requestId);
    await finishRender(row.id, out, row.createdAt, row.seed);
  } catch (e) {
    const err = e as Error;
    // A refusal is final. Anything else gets another go on the next run,
    // until the unreachable ceiling above calls it.
    if (err instanceof RenderRefused || now() - row.createdAt > RENDER_UNREACHABLE_CEILING_MS) {
      await failRender(row.id, err.message, row.createdAt);
    }
  }
}

/* ── A cited name that is a trained likeness (brief 1.3) ────────────── */

/** The ready identity behind any of these cast members, newest trained first — or none. */
export async function identityForCast(castIds: string[]): Promise<Identity | null> {
  if (!castIds.length) return null;
  await ready();
  const rs = await db().execute({
    sql: `SELECT * FROM identities WHERE status='ready' AND lora_url IS NOT NULL AND cast_id IN (${castIds.map(() => "?").join(",")}) ORDER BY trained_at DESC LIMIT 1`,
    args: castIds,
  });
  return rs.rows.length ? rowToIdentity(rs.rows[0]) : null;
}

/**
 * A still from the composer whose prompt cites a trained name: the same row
 * and meter as the Studio's own render, filed against the shot the composer
 * was on. The caller starts the render after the response (runIdentityRender).
 */
export async function startIdentityStill(opts: {
  identity: Identity; prompt: string; ratio: string; projectId: string | null; shotId: string | null; version: number;
  createdBy: string; tokenId: string | null;
}): Promise<{ genId: string; finalPrompt: string; ts: number }> {
  await ready();
  const genId = newId("gen");
  const ts = now();
  const finalPrompt = promptWithTrigger(opts.prompt, opts.identity);
  await db().execute({
    sql: `INSERT INTO generations
          (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by,
           created_at, updated_at, token_id, shot_id, version, provider, task, billed_to)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [genId, opts.projectId, null, "image", RENDERER, finalPrompt,
           JSON.stringify({ ratio: opts.ratio, resolution: "1K", rawPrompt: opts.prompt, identity: { id: opts.identity.id, name: opts.identity.name }, cast: [opts.identity.name] }),
           "running", opts.createdBy, ts, ts, opts.tokenId, opts.shotId, opts.version, "fal", "generate", "fal"],
  });
  invalidate(PROJECTS_KEY);
  try {
    await meter({ id: genId, kind: "image", engine: "fal", model: RENDERER, status: "running",
                  engineCostUsd: RENDER_USD_PER_MP, projectId: opts.projectId, shotId: opts.shotId, createdBy: opts.createdBy });
  } catch (e) {
    /* The row keeps the sentence a person reads, never the ENGINE_PAUSED: prefix the meter throws. */
    await db().execute({ sql: `UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?`, args: [enginePausedFrom(e) ?? (e as Error).message, now(), genId] }).catch(() => {});
    invalidate(PROJECTS_KEY);
    throw e;
  }
  return { genId, finalPrompt, ts };
}
