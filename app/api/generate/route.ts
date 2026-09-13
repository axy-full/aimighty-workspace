import { generatedReferenceSeconds, videoReferenceSeconds } from "@/lib/referenceDuration";
import { billCredits } from "@/lib/creditTerms";
import { NextResponse, after } from "next/server";
import { allowanceCheck, vendorKeyNameFor } from "@/lib/allowance";
import { db, ready, now, id } from "@/lib/db";
import { type VideoParams, type Reference, type ImageRole } from "@/lib/ark";
import { getModel, DEFAULT_MODEL_ID, dimensionsFor, billedFrame } from "@/lib/models";
import { estimateCostUsd, estimateImageCostUsd } from "@/lib/vendorPricing";
import { enqueueRender } from "@/lib/inngest";
import { runInline } from "@/lib/renderWork";
import {
  enhancePrompt, shouldRefine, activeWriter,
  TEXT_RATES, TEXT_RATE_FALLBACK, TEXT_FREE_TOKENS, hasFreeTier,
} from "@/lib/enhance";
import { requireRender, tokenSpendThisMonth, withTenant } from "@/lib/auth";
import { listCast, expandCast } from "@/lib/cast";
import { ceilingProblem } from "@/lib/refLimits";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { getShot, nextVersion } from "@/lib/shots";
import { houseStyle, houseStyleBlock } from "@/lib/housestyle";
import { getProvider, providerConfigured, billedTo } from "@/lib/providers";
import { getSetting } from "@/lib/settings";
import { getTask, hasTrigger, sourceAdvice, sourceProblem } from "@/lib/tasks";
import { clipDoubt, clipDoubtMessage } from "@/lib/clipTrust";
import {
  detectMove, hasCameraModule, detectSpec, inferMove, sceneLine, craftModules,
} from "@/lib/studio";
import { meter } from "@/lib/meter";
import { heldInfo, heldMessage, heldCount, notifyHeld, HELD_LIMIT } from "@/lib/held";
import { creditState, creditsApply } from "@/lib/credits";
import { requireTenant } from "@/lib/tenant";
import { submitVideoJob } from "@/lib/submitVideo";
import { checkCap } from "@/lib/caps";
import { rulesBlock, DEFAULT_LAYER } from "@/lib/platformLayer";
import { getPlatformLayer } from "@/lib/platform";
import { checkLimits, checkQuota, slotsMessage } from "@/lib/limits";
import { effectiveRules } from "@/lib/rules";
import { stillToolFor } from "@/lib/stillTools";
import { identityForCast, startIdentityStill, runIdentityRender, RENDER_USD_PER_MP, RENDER_RATIOS } from "@/lib/identities";
import { isBatchId } from "@/lib/variations";
import { uploadSourceParams } from "@/lib/sourceClip";
import { shotCapGate } from "@/lib/shotCap";
import { approvedTakeOf } from "@/lib/shots";
import { recordProvenance, portsForShot } from "@/lib/provenance";
import { reasonNeeded, cleanReason, lockAsk } from "@/lib/approval";
import { withGenerationRequest, bindGenerationRequest, reserveGenerationSpend, SpendReservationError } from "@/lib/generationRequests";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROLES: ImageRole[] = ["first_frame", "last_frame", "reference_image", "reference_video"];

/**
 * ModelArk treats these as mutually exclusive scenarios:
 *   • image-to-video (first frame, and optionally last frame) — max 2 images
 *   • omni reference-to-video — reference images and/or reference videos
 * They cannot be mixed in one request.
 */
function validateReferences(
  refs: { role: ImageRole; kind: string; durationS: number | null }[],
  model: { maxReferenceImages: number; maxReferenceVideos: number; maxVideoSecondsTotal: number; label: string }
): string | null {
  if (!refs.length) return null;

  const frames = refs.filter((r) => r.role === "first_frame" || r.role === "last_frame");
  const images = refs.filter((r) => r.role === "reference_image");
  const videos = refs.filter((r) => r.role === "reference_video");

  if (frames.length && (images.length || videos.length)) {
    return "First/last frame and reference media can't be mixed — ModelArk treats them as separate modes.";
  }
  if (frames.length) {
    if (frames.some((r) => r.kind === "video")) return "First/last frame must be an image.";
    if (frames.filter((r) => r.role === "first_frame").length > 1) return "Only one first frame.";
    if (frames.filter((r) => r.role === "last_frame").length > 1) return "Only one last frame.";
    if (!frames.some((r) => r.role === "first_frame")) {
      return "A last frame needs a first frame alongside it.";
    }
  }
  if (images.length > model.maxReferenceImages) {
    return `This model accepts at most ${model.maxReferenceImages} reference images (${images.length} attached).`;
  }
  if (videos.length > model.maxReferenceVideos) {
    return `${model.label} accepts at most ${model.maxReferenceVideos} reference videos (${videos.length} attached).`;
  }
  const totalVideoS = videos.reduce((a, v) => a + (v.durationS ?? 0), 0);
  if (totalVideoS > model.maxVideoSecondsTotal) {
    return `Reference videos total ${totalVideoS.toFixed(1)}s — ${model.label} allows ${model.maxVideoSecondsTotal}s combined.`;
  }
  return null;
}

export const POST = withTenant(async function POST(req: Request) {
  // Spending money needs a session or a render-scoped token, never a
  // read-only one.
  const got = await requireRender();
  if (got.response) return got.response;
  return withGenerationRequest(req, got.user.id, async (requestClaim) => {
  await ready();

  // A token may carry a monthly ceiling. Checked before submit, so an agent
  // in a loop stops at the wall instead of discovering it on the invoice.
  if (got.token?.capUsd != null) {
    const spent = await tokenSpendThisMonth(got.token.id);
    if (spent >= got.token.capUsd) {
      return NextResponse.json({
        error: `The token "${got.token.name}" has reached its ${got.token.capUsd.toFixed(2)} USD monthly ceiling ` +
               `(${spent.toFixed(2)} spent). Raise or remove the cap in Settings.`,
      }, { status: 429 });
    }
  }
  const body = await req.json().catch(() => ({}));

  if (body.projectId) {
    const project = await db().execute({ sql: `SELECT id FROM projects WHERE id=?`, args: [String(body.projectId)] });
    if (!project.rows.length) return NextResponse.json({ error: "No such project." }, { status: 404 });
  }
  if (body.shotId) {
    const shot = await getShot(String(body.shotId));
    if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 404 });
    if (body.projectId && shot.projectId !== String(body.projectId)) return NextResponse.json({ error: "That shot belongs to another project." }, { status: 409 });
    body.projectId = shot.projectId;
  }
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt && !getTask(String(body.task ?? "generate")).promptOptional && !stillToolFor(String(body.model ?? ""))) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  if (prompt.length > 10000)
    return NextResponse.json({ error: "Prompt is too long (10000 char max)" }, { status: 400 });

  if (body.maxCredits != null && (typeof body.maxCredits !== "number" || !Number.isInteger(body.maxCredits) || body.maxCredits < 0)) {
    return NextResponse.json({ error: "The quoted credit ceiling is invalid." }, { status: 400 });
  }
  const modelId = String(body.model ?? DEFAULT_MODEL_ID);
  let model;
  try { model = getModel(modelId); }
  catch { return NextResponse.json({ error: `Unknown model: ${modelId}` }, { status: 400 }); }
  // No key, no row: better a 400 now than a "running" render that fails later.
  const vendor = getProvider(model.provider);
  if (!providerConfigured(vendor)) {
    return NextResponse.json({
      error: `${model.label} isn't connected for this workspace. Ask the platform to connect it.`,
    }, { status: 400 });
  }
  // On the platform's keys, a workspace has a monthly allowance — the wall
  // the platform's money sits behind. Checked before anything is spent.
  const allowance = await allowanceCheck(vendorKeyNameFor(model.provider));
  /* Out of credits is not a refusal any more: the take is parked as held and
     released the moment credits arrive (lib/held.ts). A cap or a key problem
     still stops here. */
  if (!allowance.ok && allowance.status !== 402) return NextResponse.json({ error: allowance.error }, { status: allowance.status });
  if (!allowance.ok && (await heldCount()) >= HELD_LIMIT) {
    return NextResponse.json({ error: `${HELD_LIMIT} takes are already held for credits. Top up to release them before adding more.` }, { status: 402 });
  }

  /* ── Task ────────────────────────────────────────────────────────────
   * generate | edit | extend. Editing and extension are LOCKED tasks: the
   * source video dictates the output's shape, so the API must be told
   * ratio "adaptive" (both) and duration -1 (edit). lib/ark.ts applies those;
   * what happens here is deciding which source we're working on and making
   * sure the prompt actually says so — the vendor reads the intent from the
   * words, and with several videos attached the words are also how it picks
   * which one to work on.
   * ------------------------------------------------------------------ */
  const notices: string[] = [];
  const task = getTask(String(body.task ?? "generate"));
  const sourceGenId = body.sourceGenId ? String(body.sourceGenId) : null;
  /* An uploaded clip as the source of a locked task: the client sends it here, not among the references. */
  const sourceUploadId = !sourceGenId && body.sourceUploadId ? String(body.sourceUploadId) : null;

  let sourceRef: Reference | null = null;
  let sourceSeconds: number | null = null;
  let sourceResolution: string | null = null;
  /* An engine with no generate mode (Topaz only upscales) cannot be asked
     for a plain render, however it was reached. */
  if (!task.locked && !(model.supportsTasks ?? ["generate"]).includes("generate")) {
    return NextResponse.json(
      { error: `${model.label} works on a finished clip — choose one in the composer.` }, { status: 400 });
  }
  if (task.locked) {
    /* An engine that cannot do the task must say so here, not drop the
       source and render something unrelated. Absent supportsTasks means
       generate only. */
    if (model.kind === "image" || !(model.supportsTasks ?? ["generate"]).includes(task.id)) {
      return NextResponse.json(
        { error: `${model.label} can't ${task.label.toLowerCase()} — pick an engine that offers it.` },
        { status: 400 });
    }
    if (!sourceGenId && !sourceUploadId) {
      return NextResponse.json(
        { error: `${task.label} needs a clip to work on — a render from the wall, or an uploaded video.` }, { status: 400 });
    }
    if (sourceUploadId) {
      const up = await db().execute({
        sql: `SELECT id, mime, ext, stored_url, kind, duration_s, height FROM uploads WHERE id = ? LIMIT 1`,
        args: [sourceUploadId],
      });
      if (!up.rows.length) return NextResponse.json({ error: "That uploaded clip no longer exists." }, { status: 400 });
      const u = up.rows[0] as unknown as { id: string; mime: string; ext: string; stored_url: string; kind: string; duration_s: number | null; height: number | null; bytes: number | null };
      if (u.kind !== "video") return NextResponse.json({ error: `${task.label} works on video, and that upload is a still.` }, { status: 400 });
      sourceRef = { id: u.id, mime: u.mime || "video/mp4", ext: u.ext || "mp4", storedUrl: u.stored_url, role: "reference_video", kind: "video", fromGeneration: false };
      const sp = uploadSourceParams({ durationS: u.duration_s, height: u.height });
      if (typeof sp.duration === "number") sourceSeconds = sp.duration;
      if (typeof sp.resolution === "string") sourceResolution = sp.resolution;
      /* A LOCKED task is priced by the second of THIS clip, and the second
         count came out of the clip's own header — bytes the uploader chose.
         So before any ceiling is applied, refuse a length that cannot be
         believed: absent (which every ceiling below silently lets through,
         since each is written `!= null && > max`) or shorter than the file's
         own size permits. Unpriceable is not the same as cheap. */
      if (task.locked) {
        const doubt = clipDoubt(u.duration_s, u.bytes);
        if (doubt) return NextResponse.json({ error: clipDoubtMessage(doubt, task.label) }, { status: 400 });
      }
      const refused = sourceProblem(task, sp, "upload");
      if (refused) return NextResponse.json({ error: refused }, { status: 400 });
      const advice = sourceAdvice(task, typeof sp.duration === "number" ? sp.duration : null);
      if (advice) notices.push(advice);
    }
    if (!sourceUploadId) {
    const rs = await db().execute({
      sql: `SELECT id, status, stored_url, kind, params FROM generations
            WHERE id = ? AND deleted = 0 LIMIT 1`,
      args: [sourceGenId],
    });
    if (!rs.rows.length) {
      return NextResponse.json({ error: "That source render no longer exists." }, { status: 400 });
    }
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const src = rs.rows[0] as any;
    if (src.status !== "succeeded" || !src.stored_url) {
      return NextResponse.json(
        { error: "That render hasn't finished — there is nothing to work on yet." }, { status: 400 });
    }
    if (src.kind === "image") {
      return NextResponse.json(
        { error: `${task.label} works on video, and that render is a still.` }, { status: 400 });
    }
    sourceRef = {
      id: src.id, mime: "video/mp4", ext: "mp4", storedUrl: src.stored_url,
      role: "reference_video", kind: "video", fromGeneration: true,
    };
    // The guide's stability advice: edits get shaky past 20s. Worth saying
    // before the money goes, not after.
    try {
      const sp = JSON.parse(src.params || "{}") as { duration?: number; resolution?: string };
      if (typeof sp.duration === "number") sourceSeconds = sp.duration;
      if (typeof sp.resolution === "string") sourceResolution = sp.resolution;
      // The vendor's limits, applied here as well as in the picker.
      const refused = sourceProblem(task, sp);
      if (refused) return NextResponse.json({ error: refused }, { status: 400 });
      const advice = sourceAdvice(task, typeof sp.duration === "number" ? sp.duration : null);
      if (advice) notices.push(advice);
    } catch { /* unparseable params — no advice to give */ }
    }
    if (!hasTrigger(task, prompt)) {
      return NextResponse.json({
        error: `${task.label} has to say so in words — the model reads the intent from ` +
               `the prompt. Start with something like "${task.defaultTrigger}…", or use one of: ` +
               `${task.triggers.slice(0, 5).join(", ")}.`,
      }, { status: 400 });
    }
  }

  const params: VideoParams = {
    ratio: model.ratios.includes(body.ratio) ? body.ratio : model.ratios[0],
    resolution: model.resolutions.includes(body.resolution) ? body.resolution : model.resolutions[0],
    duration: task.forceDuration === "source"
      ? (sourceSeconds ?? model.durations[0] ?? 5)
      : model.durations.includes(Number(body.duration)) ? Number(body.duration) : (model.durations[0] ?? 5),
    watermark: Boolean(body.watermark ?? false),
    seed: body.seed === "" || body.seed == null ? null : Number(body.seed),
    cameraFixed: Boolean(body.cameraFixed ?? false),
    generateAudio: model.supportsAudio ? Boolean(body.generateAudio ?? false) : false,
    task: task.id,
    outputFormat: task.preferMov && (await getSetting("editOutputFormat")) === "mov" ? "mov" : "mp4",
    characterOrientation: body.characterOrientation === "image" ? "image" : "video",
    fps60: Boolean(body.fps60),
    sourceResolution: sourceResolution ?? undefined,
  };

  /* ── Reference images ────────────────────────────────────────────── */
  const wanted: { uploadId: string; role: ImageRole }[] = Array.isArray(body.references)
    ? body.references
        .map((r: { uploadId?: string; role?: string }) => ({
          uploadId: String(r?.uploadId ?? ""),
          role: (ROLES.includes(r?.role as ImageRole) ? r!.role : "reference_image") as ImageRole,
        }))
        .filter((r: { uploadId: string }) => r.uploadId)
    : [];

  /* ── Our own renders, used as references ──────────────────────────
   * A still we made is not an upload — it lives under generations/ — so it
   * cannot be hydrated from the uploads table. Referencing one used to be
   * impossible except through the locked edit and extend tasks. These are
   * resolved separately and carry fromGeneration, which the vendor adapters
   * now honour on the image path as well as the video one.
   * --------------------------------------------------------------- */
  // The source clip is the vendor's @Video 1, not a reference: never both.
  if (sourceUploadId) { const i = wanted.findIndex((w) => w.uploadId === sourceUploadId); if (i >= 0) wanted.splice(i, 1); }
  const wantedGens: { genId: string; role: ImageRole }[] = Array.isArray(body.references)
    ? body.references
        .map((r: { genId?: string; role?: string }) => ({
          genId: String(r?.genId ?? ""),
          role: (ROLES.includes(r?.role as ImageRole) ? r!.role : "reference_image") as ImageRole,
        }))
        .filter((r: { genId: string }) => r.genId)
    : [];
  const ownRefs: Reference[] = [];
  const referenceDurations: { role: ImageRole; kind: string; durationS: number | null }[] = [];
  if (wantedGens.length) {
    const rs = await db().execute({
      sql: `SELECT id, kind, status, stored_url, params FROM generations
            WHERE id IN (${wantedGens.map(() => "?").join(",")}) AND deleted = 0`,
      args: wantedGens.map((w) => w.genId),
    });
    const byId = new Map((rs.rows as unknown as {
      id: string; kind: string; status: string; stored_url: string | null; params: string;
    }[]).map((r) => [r.id, r]));
    for (const w of wantedGens) {
      const row = byId.get(w.genId);
      if (!row || row.status !== "succeeded" || !row.stored_url) {
        return NextResponse.json(
          { error: "That render can't be used as a reference — it hasn't finished, or its file is gone." },
          { status: 400 });
      }
      if (row.kind === "audio") {
        return NextResponse.json({ error: "A sound can't be a visual reference." }, { status: 400 });
      }
      const isVideo = row.kind !== "image";
      referenceDurations.push({ role: isVideo ? 'reference_video' : w.role, kind: isVideo ? 'video' : 'image', durationS: isVideo ? generatedReferenceSeconds(row.params) : null });
      ownRefs.push({
        id: row.id,
        mime: isVideo ? "video/mp4" : "image/png",
        ext: isVideo ? "mp4" : "png",
        storedUrl: row.stored_url,
        role: (model.kind === "image" ? "reference_image" : isVideo ? "reference_video" : w.role) as ImageRole,
        kind: isVideo ? "video" : "image",
        fromGeneration: true,
      });
    }
    if (model.kind === "image" && ownRefs.some((r) => r.kind === "video")) {
      return NextResponse.json(
        { error: `${model.label} takes image references only — remove the clip.` }, { status: 400 });
    }
  }

  const projectIdForCast = body.projectId ? String(body.projectId) : null;
  let references: Reference[] = [];
  let inputSeconds = 0;
  if (wanted.length) {
    const placeholders = wanted.map(() => "?").join(",");
    const rs = await db().execute({
      sql: `SELECT id, mime, ext, stored_url, kind, duration_s, derivative_url
            FROM uploads WHERE id IN (${placeholders})`,
      args: wanted.map((w) => w.uploadId),
    });
    const byId = new Map(
      rs.rows.map((r) => {
        const row = r as unknown as {
          id: string; mime: string; ext: string; stored_url: string;
          kind: string; duration_s: number | null; derivative_url: string | null;
        };
        return [row.id, row];
      })
    );
    const missing = wanted.filter((w) => !byId.has(w.uploadId));
    if (missing.length) {
      return NextResponse.json({ error: "A reference is no longer available." }, { status: 400 });
    }

    // The KIND is the database's word, never the client's: a video row is a
    // reference_video no matter what role the request claimed.
    const enriched = wanted.map((w) => {
      const row = byId.get(w.uploadId)!;
      const kind = row.kind === "video" ? "video" : "image";
      return {
        uploadId: w.uploadId,
        role: (model.kind === "image"
          ? "reference_image"
          : kind === "video" ? "reference_video" : w.role === "reference_video" ? "reference_image" : w.role) as ImageRole,
        kind,
        durationS: row.duration_s,
      };
    });

    if (model.kind === "image") {
      if (enriched.some((r) => r.kind === "video")) {
        return NextResponse.json(
          { error: `${model.label} takes image references only — remove the video.` },
          { status: 400 });
      }
      if (enriched.length > model.maxReferenceImages) {
        return NextResponse.json(
          { error: `${model.label} accepts at most ${model.maxReferenceImages} reference images.` },
          { status: 400 });
      }
    }
    referenceDurations.push(...enriched);

    // Preserve the order the user arranged — @Image1 is the first image.
    references = enriched.map((w) => {
      const row = byId.get(w.uploadId)!;
      return {
        id: row.id, mime: row.mime, ext: row.ext, storedUrl: row.stored_url,
        role: w.role, kind: w.kind as "image" | "video",
        deliveryUrl: row.derivative_url ?? null,
      };
    });
  }

  // Our own renders join the list after the uploads, so a person's own
  // @Image1 stays their first attached file.
  references.push(...ownRefs);
  const knownInputSeconds = videoReferenceSeconds(referenceDurations);
  if (knownInputSeconds == null) return NextResponse.json({ error: "A reference video's duration is unavailable. Upload the clip again before generating." }, { status: 400 });
  inputSeconds = knownInputSeconds;
  if (model.kind === "video") {
    const refProblem = validateReferences(referenceDurations, model);
    if (refProblem) return NextResponse.json({ error: refProblem }, { status: 400 });
  }

  /* The source goes first: with several videos attached the model decides
   * which one to work on from the prompt, and leading with it matches the
   * guide's own examples ("@video1" as the thing being edited). */
  if (sourceRef) {
    references.unshift(sourceRef);
    inputSeconds += sourceSeconds ?? 0;
  }

  /* ── The cast ────────────────────────────────────────────────────────
   * @Maya means something specific in this workspace. Resolve those names
   * into the @ImageN citations the engines understand, attaching each one's
   * still after whatever references the request already carried, so a face
   * or a street stays the same shot after shot without being re-described.
   * ------------------------------------------------------------------ */
  let castPrompt = prompt;
  let castUsed: string[] = [];
  let castIds: string[] = [];
  if (/@[A-Za-z]/.test(prompt)) {
    const roster = await listCast(projectIdForCast);
    const startIndex = references.filter(
      (r) => r.kind === "image" && r.role === "reference_image"
    ).length;
    const expanded = expandCast(prompt, roster, startIndex);

    if (expanded.attach.length) {
      const rs = await db().execute({
        sql: `SELECT id, mime, ext, stored_url, kind, derivative_url
              FROM uploads WHERE id IN (${expanded.attach.map(() => "?").join(",")})`,
        args: expanded.attach,
      });
      const byId = new Map(rs.rows.map((r) => {
        const row = r as unknown as { id: string; mime: string; ext: string;
                                      stored_url: string; kind: string; derivative_url: string | null };
        return [row.id, row];
      }));
      // Keep the order expandCast assigned — it decided the @ImageN numbers.
      for (const uploadId of expanded.attach) {
        const row = byId.get(uploadId);
        if (!row) continue;
        references.push({
          id: row.id, mime: row.mime, ext: row.ext, storedUrl: row.stored_url,
          role: "reference_image", kind: "image",
          deliveryUrl: row.derivative_url ?? null,
        });
      }
    }
    castPrompt = expanded.prompt;
    castUsed = expanded.used.map((m) => m.name);
    castIds = expanded.used.map((m) => m.id);
  }

  /* THE CEILING IS COUNTED AFTER THE CAST, because the cast attaches too.
     References were validated at the point they arrived from the browser —
     which is before `expandCast` pushes a still for every cited name. So
     attaching two images to a two-image model and then citing @Mara and
     @Mule passed the check with two and left with four, and nothing said
     so. The still path already counts them (see the identical check on the
     image branch below, and its comment); the video path never did.
     What the engine then does with the surplus is not a refusal but a
     silent change of meaning: fal takes images[0] as the FIRST FRAME and
     the next as the LAST FRAME (lib/falVideo.ts:132-134) and discards the
     rest, so a reference the person attached can quietly become a frame
     and turn a text-to-video into an image-to-video. Some models take no
     reference images at all (`maxReferenceImages: 0`). */
  /* Only the image rules are re-checked, and deliberately: the cast adds
     `reference_image` rows and nothing else, so the video count and the
     total-seconds budget were settled at the earlier check and the
     durations needed to re-test them are not carried on a Reference. */
  const afterCast = ceilingProblem(references, model, castUsed);
  if (afterCast) return NextResponse.json({ error: afterCast }, { status: 400 });

  /* Motion control moves a character: it needs the still as well as the clip. */
  if (task.needsImage && !references.some((r) => r.kind === "image")) {
    return NextResponse.json(
      { error: `${task.label} needs a still of the character — attach one, or cite a cast member.` }, { status: 400 });
  }

  /* ── Still engines (Nano Banana Pro) ─────────────────────────────────
   * Google renders synchronously and thinks before it draws, so there is no
   * task id to poll: the row goes in as running, the response returns at
   * once, and the render finishes inside after() — the client's ordinary
   * polling picks it up. The prompt goes as written (the cast resolved, a
   * raw: prefix honoured); the model reasons about it itself. A refusal
   * fails the row in Google's own words and is never charged.
   * ------------------------------------------------------------------ */
  /* The platform layer: its rules apply to every prompt in scope (lib/platformLayer.ts). */
  const layer = await getPlatformLayer().catch(() => DEFAULT_LAYER);
  // The rules in force HERE: the platform's, less what this workspace switched off, plus its own.
  const rules = await effectiveRules().catch(() => layer.rules);
  if (model.kind === "image") {
    const ratio = model.ratios.includes(body.ratio) ? String(body.ratio) : model.ratios[0];
    const size = model.resolutions.includes(body.resolution)
      ? String(body.resolution) : model.resolutions[0];
    const isRaw = /^raw:/i.test(castPrompt);
    const stillRules = isRaw || model.stillTask ? "" : rulesBlock(rules, "image", "prompt", model.family);
    const stillPrompt = isRaw
      ? castPrompt.replace(/^raw:\s*/i, "")
      : stillRules && !castPrompt.includes(stillRules) ? `${castPrompt.trim()}\n\n${stillRules}` : castPrompt;
    const stillProject = body.projectId ? String(body.projectId) : null;
    const stillShot = body.shotId ? String(body.shotId) : null;
    let stillVersion = 1;
    let stillShotCode: string | null = null;
    let stillReason: string | null = null;
    if (stillShot) {
      const shot = await getShot(stillShot);
      if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 400 });
      stillShotCode = shot.code;
      const approved = await approvedTakeOf(stillShot);
      if (reasonNeeded({ hasApprovedTake: Boolean(approved), reason: body.reason })) {
        const ask = lockAsk(approved!.version, approved!.by);
        return NextResponse.json({ error: ask.title, line: ask.line, needsReason: true, approvedVersion: approved!.version }, { status: 409 });
      }
      stillReason = cleanReason(body.reason);
      stillVersion = await nextVersion(stillShot);
    }
    const stillRefs = references.filter((r) => r.kind === "image");
    if (model.stillTask && stillRefs.length !== 1) return NextResponse.json({ error: "Pick the still to work on." }, { status: 400 });
    // The cast just added its stills — the vendor's ceiling counts those too.
    if (stillRefs.length > model.maxReferenceImages) {
      return NextResponse.json({
        error: `${model.label} accepts at most ${model.maxReferenceImages} reference images including cast stills (${stillRefs.length} attached).`,
      }, { status: 400 });
    }
    /* The price, on the server: the wall checks the workspace can pay it,
       and the meter opens the job with it as the estimate. */
    /* A cited name that is a trained likeness: the still renders through Flux
       with the identity's own model (brief 1.3), priced as that render. */
    const trained = !model.stillTask && castIds.length ? await identityForCast(castIds) : null;
    const estStillUsd = trained ? RENDER_USD_PER_MP : (estimateImageCostUsd(modelId, size, stillRefs.length)?.net ?? 0);
    if (body.maxCredits != null && billCredits(estStillUsd, modelId) > body.maxCredits) {
      return NextResponse.json({ error: "The generation estimate changed. Review the updated credit quote before generating." }, { status: 409 });
    }
    /* The cost approval rule (brief 2.2): with a cap per shot, a member's take past it needs an admin. */
    if (stillShot && stillShotCode) {
      const stop = await shotCapGate({ shotId: stillShot, code: stillShotCode, takeUsd: estStillUsd, modelId, isAdmin: got.user.role === "admin" });
      if (stop) return NextResponse.json({ error: stop, needsAdmin: true }, { status: 403 });
    }
    const wallStill = await allowanceCheck(vendorKeyNameFor(model.provider), estStillUsd, modelId);
    if (!wallStill.ok && wallStill.status !== 402) return NextResponse.json({ error: wallStill.error }, { status: wallStill.status });
    let holdStill = !wallStill.ok ? heldInfo(estStillUsd, "image", modelId) : null;
    const capStill = await checkCap(stillProject, estStillUsd, modelId);
    if (!capStill.allow) return NextResponse.json({ error: capStill.error }, { status: 409 });
    const limStill = await checkLimits();
    if (!limStill.allow && limStill.why === "rate") return NextResponse.json({ error: limStill.error }, { status: 429 });
    if (!holdStill && !limStill.allow) holdStill = heldInfo(estStillUsd, "image", modelId, "slots");
    const quotaStill = await checkQuota(0);
    if (!quotaStill.allow) return NextResponse.json({ error: quotaStill.error }, { status: 507 });
    if (trained) {
      if (holdStill) return NextResponse.json({ error: !wallStill.ok ? wallStill.error : "Every render slot is busy; try again in a moment." }, { status: !wallStill.ok ? 402 : 429 });
      const idRatio = (RENDER_RATIOS as readonly string[]).includes(ratio) ? ratio : "16:9";
      const started = await startIdentityStill({ identity: trained, prompt, ratio: idRatio, projectId: stillProject, shotId: stillShot, version: stillVersion, createdBy: got.user.id, tokenId: got.token?.id ?? null });
      await bindGenerationRequest(requestClaim, started.genId);
      try {
        await reserveGenerationSpend({ id: started.genId, kind: "image", engine: "fal", model: "fal-ai/flux-lora", status: "running",
          engineCostUsd: estStillUsd, projectId: stillProject, shotId: stillShot, createdBy: got.user.id }, { token: got.token });
      } catch (e) {
        await meter({ id: started.genId, kind: "image", engine: "fal", model: "fal-ai/flux-lora", status: "failed", engineCostUsd: 0 });
        await db().execute({ sql: `UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?`, args: [(e as Error).message, now(), started.genId] });
        return NextResponse.json({ id: started.genId, status: "failed", error: (e as Error).message }, { status: e instanceof SpendReservationError ? e.status : 503 });
      }
      after(() => runIdentityRender(started.genId, trained, { prompt: started.finalPrompt, ratio: idRatio, seed: null, startedAt: started.ts }));
      return NextResponse.json({ id: started.genId, status: "running", identity: trained.name });
    }
    const genId = id("gen");
    const ts = now();
    const stillParams = {
      ratio, resolution: size,
      /* Its role on the production, chosen in the composer's USE AS row: a
         first frame pinned to its shot, a cast still, or loose. */
      useAs: ["first", "cast", "loose"].includes(String(body.useAs)) ? String(body.useAs) : undefined,
      castName: body.castName ? String(body.castName).replace(/^@/, "").trim().slice(0, 40) : undefined,
      // A reference is recorded by WHICH STORE it came from, because the
      // worker rebuilds this job from the row and has to look in the right
      // place. An id alone would be ambiguous.
      references: stillRefs.map((r) => (r.fromGeneration
        ? { genId: r.id, role: r.role, kind: r.kind }
        : { uploadId: r.id, role: r.role, kind: r.kind })),
      /* What the person typed, whenever the take carries something else: the
         cast expanded, the writer rewrote, or the rule library appended its
         own lines. The theatre shows this, and a fresh render is built from
         it rather than from the compiled text (brief 2.5). */
      rawPrompt: stillPrompt !== prompt ? prompt : undefined,
      cast: castUsed.length ? castUsed : undefined,
      reason: stillReason ?? undefined,
      batchId: isBatchId(body.batchId) ? body.batchId : undefined,
      variation: isBatchId(body.batchId) && Number.isInteger(body.variation) && body.variation >= 1 && body.variation <= 8 ? body.variation : undefined,
    };

    await db().execute({
      sql: `INSERT INTO generations
            (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by,
             created_at, updated_at, token_id, shot_id, version, provider, task, billed_to)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, stillProject, null, "image", modelId, stillPrompt,
             JSON.stringify(holdStill ? { ...stillParams, held: holdStill } : stillParams), holdStill ? "held" : "running", got.user.id, ts, ts,
             got.token?.id ?? null, stillShot, stillVersion, model.provider, model.stillTask ?? "generate",
             billedTo(model.provider)],
    });
    await bindGenerationRequest(requestClaim, genId);
    invalidate(PROJECTS_KEY);
    if (holdStill) {
      if (holdStill.why === "slots") {
        return NextResponse.json({ id: genId, status: "held", held: true, why: "slots", notices: [slotsMessage(limStill.standing.running, limStill.limits.concurrency)] }, { status: 202 });
      }
      const left = (await creditState())?.balance ?? 0;
      await notifyHeld({ id: genId, needs: holdStill.needs, left }).catch(() => {});
      return NextResponse.json({ id: genId, status: "held", held: true, needs: holdStill.needs, notices: [heldMessage(holdStill.needs, left)] }, { status: 202 });
    }
    try {
      await reserveGenerationSpend({ id: genId, kind: "image", engine: billedTo(model.provider), model: modelId, status: "running",
                    engineCostUsd: estStillUsd, projectId: stillProject, shotId: stillShot, createdBy: got.user.id }, { token: got.token });
    } catch (e) {
      await db().execute({ sql: `UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?`, args: [(e as Error).message, now(), genId] });
      invalidate(PROJECTS_KEY);
      return NextResponse.json({ id: genId, status: "failed", error: (e as Error).message }, { status: e instanceof SpendReservationError ? e.status : 503 });
    }

    /* The render itself now belongs to the worker: the row is written, the
       event is sent, and Inngest drives the vendor call outside this request
       where a reclaimed instance cannot lose it. If there is no queue to
       hand — no keys, or the send failed — it runs here in after() exactly
       as it always did. Same code either way; see lib/renderWork.ts. */
    if (!(await enqueueRender(genId, "image"))) {
      after(() => runInline(genId));
    }

    return NextResponse.json({ id: genId, status: "running", notices: capStill.notice ? [capStill.notice] : undefined });
  }

  /* ── Auto-refine ─────────────────────────────────────────────────────
   * Every prompt passes through ByteDance's own optimization recipe before
   * it reaches Seedance — the layer aggregators charge for, on by default.
   *  • already-structured prompts (the 【…】 form) pass through untouched,
   *    so re-rendering a refined prompt doesn't drift it
   *  • a "raw:" prefix sends the exact words, minus the prefix
   *  • if the text model is unreachable, the render proceeds with the raw
   *    prompt — a $0.001 helper must never block a paid render
   * The stored prompt is what actually generated the video; the original
   * idea is kept alongside it in params.rawPrompt.
   * ------------------------------------------------------------------ */
  let finalPrompt = castPrompt;
  let rawPrompt: string | undefined = castPrompt !== prompt ? prompt : undefined;
  let refineModel: string | null = null;
  let refineIn = 0, refineOut = 0;
  /** How long the prompt writer held the submit up. Null when it never ran. */
  let refineMs: number | null = null;
  let refineCost: number | null = null;
  /* ── Library-first composition ───────────────────────────────────────
   * The bank supplies the craft; the author's words stay the author's words.
   * We read what they already specified, fill the rest from the library, and
   * only call a model when there is too little prompt to film at all.
   * ------------------------------------------------------------------ */
  let chosenMove: string | null = null;
  const detected = detectSpec(castPrompt);
  const detectedAxes = Object.values(detected).filter(Boolean).length;

  /* The rate limit is asked HERE as well as below, because the prompt writer
     is a paid call and it used to run first. A request that the limit was
     going to refuse still paid for its refine on the way to being told no —
     so a loop against a rate-limited workspace bought gateway text at the
     platform's expense and rendered nothing, which is a cheaper way to spend
     somebody's money than actually rendering.
     Only the "rate" refusal is taken early; a "slots" verdict still falls
     through, because that one parks the take rather than refusing it and the
     prompt is wanted when it releases. Identical to the check below. */
  const limEarly = await checkLimits();
  if (!limEarly.allow && limEarly.why === "rate") {
    return NextResponse.json({ error: limEarly.error }, { status: 429 });
  }

  const refineCall = shouldRefine(castPrompt, detectedAxes);
  const writer = await activeWriter();
  if (task.id === "motion" || task.id === "upscale" || task.id === "reframe") {
    // The clip is the brief: nothing here for a prompt writer to improve.
  } else if (/^raw:/i.test(castPrompt)) {
    finalPrompt = castPrompt.replace(/^raw:\s*/i, "");
  } else if (creditsApply(requireTenant()) || body.refine === false || writer.writer === "none") {
    // Customer quotes cover this render. Paid prompt work is a separate,
    // explicit Atomik action; never add an unquoted model call here.
    // Pro: the workspace has said its prompts are not to be rewritten.
    console.log("generate: skipping refine — writer is Pro");
  } else if (!refineCall.refine) {
    // Already specific enough to film. Rewriting it would cost money and up
    // to a minute of latency to replace the author's restraint with invented
    // detail, so it goes as written.
    console.log(`generate: skipping refine — ${refineCall.why}`);
  } else {
    const citations = [
      ...references.filter((r) => r.kind === "image" && r.role === "reference_image")
        .map((_, i) => `@Image${i + 1} (image)`),
      ...references.filter((r) => r.role === "first_frame").map(() => "a first-frame image"),
      ...references.filter((r) => r.role === "last_frame").map(() => "a last-frame image"),
      ...references.filter((r) => r.kind === "video").map((_, i) => `@Video${i + 1} (video)`),
    ];
    try {
      // The engine and the length steer the form: 2.5 takes integer-second
      // timestamps, 2.0 only shot numbers, and the script should fill the
      // duration actually being paid for.
      // Show it the work this studio has actually approved, so the writing
      // converges on their taste rather than on a generic one.
      const writerRules = rulesBlock(rules, "video", "writer", model.family);
      const style = [houseStyleBlock(await houseStyle(projectIdForCast)), writerRules ? `THE PLATFORM'S RULES\n${writerRules}` : ""].filter(Boolean).join("\n\n");
      const refineStartedAt = now();
      const r = await enhancePrompt({
        prompt: castPrompt, citations,
        model: modelId, durationS: params.duration, task: task.id, style,
        provider: writer.provider === "none" ? undefined : writer.provider,
      });
      refineMs = now() - refineStartedAt;
      finalPrompt = r.text;
      chosenMove = r.move ?? null;
      rawPrompt = prompt;   // the words a person actually typed
      refineModel = r.model;
      refineIn = r.inTokens;
      refineOut = r.outTokens;

      // The first 500k tokens per text model are free; past that, list rates.
      // Cumulative usage comes from what previous renders recorded. Two
      // concurrent renders can both read the same cumulative figure — at
      // worst one row at the 500k boundary is charged a fraction wrongly.
      const usedRs = await db().execute({
        sql: `SELECT COALESCE(SUM(COALESCE(refine_in_tokens,0)+COALESCE(refine_out_tokens,0)),0) AS n
              FROM generations WHERE refine_model = ?`,
        args: [refineModel],
      });
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const usedBefore = Number((usedRs.rows[0] as any)?.n ?? 0);
      const rowTokens = refineIn + refineOut;
      // The 500k allowance is a ByteDance arrangement. Anthropic bills from
      // token one, so a Claude refine is never discounted here.
      const freeLeft = hasFreeTier(refineModel)
        ? Math.max(0, TEXT_FREE_TOKENS - usedBefore) : 0;
      const billable = Math.max(0, rowTokens - freeLeft);
      const frac = rowTokens > 0 ? billable / rowTokens : 0;
      const rate = TEXT_RATES[refineModel] ?? TEXT_RATE_FALLBACK;
      // The gateway states the exact charge, cache discounts included; that
      // beats pricing tokens at list. Anyone else is priced from the table.
      refineCost = typeof r.costUsd === "number"
        ? r.costUsd
        : frac * (refineIn * rate.input + refineOut * rate.output) / 1_000_000;
    } catch (e) {
      console.error("auto-refine unavailable, rendering raw:", (e as Error).message);
    }
  }

  /* ── The camera module ───────────────────────────────────────────────
   * Higgsfield's move: the camera is a self-contained, scene-independent
   * block, written precisely enough that the engine cannot read it as a
   * neighbouring move. This attaches one to EVERY render, not just the ones
   * composed in the Studio.
   *
   * It is not inventing a camera. Either the author named a move — in which
   * case expanding "handheld" into its sixty rigorous words is honouring
   * their choice, not overriding it — or the refine layer picked the plainest
   * move that serves the action. A prompt that already carries a full module
   * (composed in the Studio) is left alone.
   * ------------------------------------------------------------------ */
  if (!task.locked && !/^raw:/i.test(castPrompt)) {
    /* Expand only where the library's wording is materially more precise
     * than the author's. Detection found these terms BY reading them, so
     * restating "35mm" as "shot on a 35mm lens" adds a duplicate and no
     * information. Sound and subtitles are the exception: those are the two
     * negatives the engine actually honours, and it honours the specific
     * phrasing — "no BGM; environmental and action sound only" lands where a
     * bare "no music" does not. */
    const spec = detectSpec(finalPrompt);
    const extras = sceneLine({ sound: spec.sound ?? "", titles: spec.titles ?? "" });
    if (extras && !finalPrompt.toLowerCase().includes(extras.slice(0, 24).toLowerCase())) {
      finalPrompt = `${finalPrompt.trim()}\n\n${extras}.`;
    }

    if (!hasCameraModule(finalPrompt)) {
      const named = detectMove(finalPrompt) ?? detectMove(prompt);
      const fromModel = chosenMove
        ? (detectMove(chosenMove) ?? { kind: "move" as const, value: chosenMove })
        : null;
      // Nobody named one and no model was called: read it off the action
      // rather than leaving the engine to invent a move.
      const inferred = { kind: "move" as const, value: inferMove(finalPrompt) };
      const choice = named ?? fromModel ?? inferred;

      // Camera, plus the light and look the author already named — each from
      // the bank, so the wording is identical on every render that uses it.
      const craft = craftModules({
        [choice.kind]: choice.value,
        light: spec.light ?? "",
        look: spec.look ?? "",
      });
      if (craft) finalPrompt = `${finalPrompt.trim()}\n\n${craft}`;
    }
  }

  /* The platform's rules in scope, as plain sentences at the end — never on
     a raw: prompt, never on a clip that is itself the brief. */
  if (!/^raw:/i.test(castPrompt) && task.id !== "motion" && task.id !== "upscale" && task.id !== "reframe") {
    const promptRules = rulesBlock(rules, "video", "prompt", model.family);
    if (promptRules && !finalPrompt.includes(promptRules)) finalPrompt = `${finalPrompt.trim()}\n\n${promptRules}`;
  }

  /* The vendor reads the intent from the prompt it actually receives, which
   * is the REFINED one. The refine layer is instructed to keep the verb, but
   * if it ever drops it the request silently stops being an edit — so check
   * the final text and put the verb back rather than trusting the rewrite. */
  if (task.locked && !hasTrigger(task, finalPrompt)) {
    finalPrompt = `${task.defaultTrigger} @Video1: ${finalPrompt}`;
    console.warn(`generate: refined prompt lost its ${task.id} trigger; restored it`);
  }

  const projectId = body.projectId ? String(body.projectId) : null;

  /* ── Which shot is this a take of? ───────────────────────────────────
   * Filing the render against a shot is what makes it version 3 of SH110
   * rather than another anonymous mp4 — it drives the revision count, the
   * canvas grouping and the download's name.
   * ------------------------------------------------------------------ */
  const shotId = body.shotId ? String(body.shotId) : null;
  let version = 1;
  let shotCode: string | null = null;
  let reason: string | null = null;
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 400 });
    shotCode = shot.code;
    /* A shot with an approved take is locked: the next take says why (brief 2.1). */
    const approved = await approvedTakeOf(shotId);
    if (reasonNeeded({ hasApprovedTake: Boolean(approved), reason: body.reason })) {
      const ask = lockAsk(approved!.version, approved!.by);
      return NextResponse.json({ error: ask.title, line: ask.line, needsReason: true, approvedVersion: approved!.version }, { status: 409 });
    }
    reason = cleanReason(body.reason);
    version = await nextVersion(shotId);
  }

  const estUsd = estimateCostUsd(
    modelId, params.resolution, params.ratio, params.duration, inputSeconds, references.some((r) => r.kind === "video"),
    { audio: params.generateAudio, task: task.id, fps60: params.fps60 },
  )?.net ?? 0;
  if (body.maxCredits != null && billCredits(estUsd, modelId) > body.maxCredits) {
    return NextResponse.json({ error: "The generation estimate changed. Review the updated credit quote before generating." }, { status: 409 });
  }
  /* The cost approval rule (brief 2.2): with a cap per shot, a member's take past it needs an admin. */
  if (shotId && shotCode) {
    const stop = await shotCapGate({ shotId: shotId, code: shotCode, takeUsd: estUsd, modelId, isAdmin: got.user.role === "admin" });
    if (stop) return NextResponse.json({ error: stop, needsAdmin: true }, { status: 403 });
  }
  const wall = await allowanceCheck(vendorKeyNameFor(model.provider), estUsd, modelId);
  if (!wall.ok && wall.status !== 402) return NextResponse.json({ error: wall.error }, { status: wall.status });
  let hold = !wall.ok ? heldInfo(estUsd, "video", modelId) : null;
  const capV = await checkCap(projectId, estUsd, modelId);
  if (!capV.allow) return NextResponse.json({ error: capV.error }, { status: 409 });
  if (capV.notice) notices.push(capV.notice);
  const lim = await checkLimits();
  if (!lim.allow && lim.why === "rate") return NextResponse.json({ error: lim.error }, { status: 429 });
  if (!hold && !lim.allow) hold = heldInfo(estUsd, "video", modelId, "slots");
  const quota = await checkQuota(0);
  if (!quota.allow) return NextResponse.json({ error: quota.error }, { status: 507 });

  const genId = id("gen");
  const ts = now();
  const hasVideoInput = references.some((r) => r.kind === "video");
  // The shot-control chips are kept as data, not just baked into the prose,
  // so re-opening a take brings them back set — changing one control and
  // running it again is the entire reason to have them.
  const shotSpec = body.shotSpec && typeof body.shotSpec === "object"
    ? Object.fromEntries(
        Object.entries(body.shotSpec as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string" && v)
          .slice(0, 20)
          .map(([k, v]) => [k.slice(0, 24), String(v).slice(0, 40)]))
    : null;

  const storedParams = {
    ...params,
    references: references.map((r) => (r.fromGeneration
      ? { genId: r.id, role: r.role, kind: r.kind }
      : { uploadId: r.id, role: r.role, kind: r.kind })),
    hasVideoInput,
    inputSeconds: hasVideoInput ? inputSeconds : undefined,
    rawPrompt,
    cast: castUsed.length ? castUsed : undefined,
    // Why this take was made past an approved one (brief 2.1).
    reason: reason ?? undefined,
    // Siblings of one press (brief 1.6), so the wall shows them as one strip.
    batchId: isBatchId(body.batchId) ? body.batchId : undefined,
    variation: isBatchId(body.batchId) && Number.isInteger(body.variation) && body.variation >= 1 && body.variation <= 8 ? body.variation : undefined,
    shotSpec: shotSpec && Object.keys(shotSpec).length ? shotSpec : undefined,
    // The bank's neutral preview this clip is for, when the console rendered it for one (brief 1.4).
    previewFor: typeof body.previewFor === "string" && /^[a-z]+:[a-z0-9_-]+$/i.test(body.previewFor) ? body.previewFor : undefined,
    task: task.id !== "generate" ? task.id : undefined,
    sourceGenId: sourceGenId ?? undefined,
    sourceUploadId: sourceUploadId ?? undefined,
    sourceSeconds: sourceSeconds ?? undefined,
    // What the vendor locked for us, so the record explains its own shape.
    locked: task.locked
      ? { ratio: task.forceRatio, duration: task.forceDuration } : undefined,
  };

  // Row first, so a failed submit is still visible rather than silently lost.
  await db().execute({
    sql: `INSERT INTO generations
          (id, project_id, ark_task_id, model, prompt, params, status, created_by, created_at, updated_at,
           refine_model, refine_in_tokens, refine_out_tokens, refine_cost_usd, token_id,
           shot_id, version, provider, task, source_gen_id, refine_ms, billed_to)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [genId, projectId, null, modelId, finalPrompt, JSON.stringify(hold ? { ...storedParams, held: hold } : storedParams), hold ? "held" : "queued",
           got.user.id, ts, ts,
           refineModel, refineModel ? refineIn : null, refineModel ? refineOut : null, refineCost,
           got.token?.id ?? null,
           shotId, version, model.provider ?? "byteplus", task.id, sourceGenId, refineMs,
           billedTo(model.provider ?? "byteplus")],
  });

  await bindGenerationRequest(requestClaim, genId);

  /* What made this take, written once and never afterwards (brief 3, 1c).
     Additive and best-effort: it happens after the row exists, it cannot
     fail the render, and it changes nothing about what is sent to the
     engine. Binding resolution reaching the COMPILER is a separate change
     with a golden-prompt test; this only writes down what was in force. */
  void (async () => {
    const { rows, keys } = shotId ? await portsForShot(shotId) : { rows: [], keys: [] };
    await recordProvenance(genId, shotId, {
      engine: billedTo(model.provider ?? "byteplus"),
      model: modelId,
      provider: model.provider ?? "byteplus",
      ports: keys,
      cast: castUsed,
      setup: shotSpec ?? {},
      /* The ids of the rules that applied. The original schema plan called
         these unrecoverable for old takes; they are recorded from here on. */
      rules: rules.map((r) => r.id),
      conditions: {
        /* The file's own frame, and the frame the engine metered — they
           differ because the engine bills on a sixteen-pixel grid, and the
           card says both rather than pretending they are one number. */
        width: dimensionsFor(String(params.resolution ?? ""), String(params.ratio ?? ""))?.w ?? null,
        height: dimensionsFor(String(params.resolution ?? ""), String(params.ratio ?? ""))?.h ?? null,
        billedWidth: billedFrame(String(params.resolution ?? ""), String(params.ratio ?? ""))?.w ?? null,
        billedHeight: billedFrame(String(params.resolution ?? ""), String(params.ratio ?? ""))?.h ?? null,
        durationSeconds: typeof params.duration === "number" ? params.duration : null,
        /* Null until the vendor hands one back — unrecorded is the honest
           answer, and "make another from exactly this" says so. */
        seed: null,
      },
      by: got.user.id,
      at: ts,
    }, rows);
  })().catch(() => {});

  invalidate(PROJECTS_KEY);
  if (hold) {
    if (hold.why === "slots") {
      return NextResponse.json({ id: genId, status: "held", held: true, why: "slots", notices: [slotsMessage(lim.standing.running, lim.limits.concurrency)] }, { status: 202 });
    }
    const left = (await creditState())?.balance ?? 0;
    await notifyHeld({ id: genId, needs: hold.needs, left }).catch(() => {});
    return NextResponse.json({ id: genId, status: "held", held: true, needs: hold.needs, notices: [heldMessage(hold.needs, left)] }, { status: 202 });
  }
  try {
    await reserveGenerationSpend({ id: genId, kind: "video", engine: billedTo(model.provider ?? "byteplus"), model: modelId, status: "running",
                  engineCostUsd: estUsd, projectId, shotId, createdBy: got.user.id }, { token: got.token });
  } catch (e) {
    await db().execute({ sql: `UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?`, args: [(e as Error).message, now(), genId] });
    invalidate(PROJECTS_KEY);
    return NextResponse.json({ id: genId, status: "failed", error: (e as Error).message }, { status: e instanceof SpendReservationError ? e.status : 503 });
  }

  const out = await submitVideoJob({ genId, model, task, prompt: finalPrompt, params, references, source: sourceRef, ts });
  if (!out.ok) return NextResponse.json({ id: genId, status: "failed", error: out.error }, { status: 502 });
  return NextResponse.json({
    id: genId, arkTaskId: out.taskId, status: "running", attempts: out.attempts,
      notices: notices.length ? notices : undefined,
  });
  });
});
