import { NextResponse, after } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { submitTask, type VideoParams, type Reference, type ImageRole } from "@/lib/ark";
import {
  getModel, DEFAULT_MODEL_ID, IMAGE_OUT_USD, IMAGE_REF_IN_USD, imageTokens,
} from "@/lib/models";
import { generateImage } from "@/lib/gemini";
import { storeImageBytes } from "@/lib/storage";
import {
  enhancePrompt, shouldRefine, TEXT_RATES, TEXT_RATE_FALLBACK, TEXT_FREE_TOKENS, hasFreeTier,
} from "@/lib/enhance";
import { requireRender, tokenSpendThisMonth } from "@/lib/auth";
import { listCast, expandCast } from "@/lib/cast";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";
import { getShot, nextVersion } from "@/lib/shots";
import { houseStyle, houseStyleBlock } from "@/lib/housestyle";
import { withRetry, classifyFailure, getProvider, providerConfigured } from "@/lib/providers";
import { getSetting } from "@/lib/settings";
import { getTask, hasTrigger, sourceAdvice } from "@/lib/tasks";
import {
  detectMove, hasCameraModule, detectSpec, inferMove, sceneLine, craftModules,
} from "@/lib/studio";

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

export async function POST(req: Request) {
  // Spending money needs a session or a render-scoped token, never a
  // read-only one.
  const got = await requireRender();
  if (got.response) return got.response;
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

  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  if (prompt.length > 10000)
    return NextResponse.json({ error: "Prompt is too long (10000 char max)" }, { status: 400 });

  const modelId = String(body.model ?? DEFAULT_MODEL_ID);
  let model;
  try { model = getModel(modelId); }
  catch { return NextResponse.json({ error: `Unknown model: ${modelId}` }, { status: 400 }); }
  // No key, no row: better a 400 now than a "running" render that fails later.
  const vendor = getProvider(model.provider);
  if (!providerConfigured(vendor)) {
    return NextResponse.json({
      error: `${model.label} needs a ${vendor.label} key on this deployment — set ${vendor.envKey} in Vercel and redeploy.`,
    }, { status: 400 });
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

  let sourceRef: Reference | null = null;
  if (task.locked) {
    if (!sourceGenId) {
      return NextResponse.json(
        { error: `${task.label} needs a source render to work on.` }, { status: 400 });
    }
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
      const sp = JSON.parse(src.params || "{}") as { duration?: number };
      const advice = sourceAdvice(task, typeof sp.duration === "number" ? sp.duration : null);
      if (advice) notices.push(advice);
    } catch { /* unparseable params — no advice to give */ }
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
    duration: model.durations.includes(Number(body.duration))
      ? Number(body.duration) : model.durations[0],
    watermark: Boolean(body.watermark ?? false),
    seed: body.seed === "" || body.seed == null ? null : Number(body.seed),
    cameraFixed: Boolean(body.cameraFixed ?? false),
    generateAudio: model.supportsAudio ? Boolean(body.generateAudio ?? false) : false,
    task: task.id,
    outputFormat: task.preferMov && (await getSetting("editOutputFormat")) === "mov" ? "mov" : "mp4",
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
    } else {
      const refProblem = validateReferences(enriched, model);
      if (refProblem) return NextResponse.json({ error: refProblem }, { status: 400 });
    }

    inputSeconds = enriched
      .filter((r) => r.kind === "video")
      .reduce((a, r) => a + (r.durationS ?? 0), 0);

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

  /* The source goes first: with several videos attached the model decides
   * which one to work on from the prompt, and leading with it matches the
   * guide's own examples ("@video1" as the thing being edited). */
  if (sourceRef) references.unshift(sourceRef);

  /* ── The cast ────────────────────────────────────────────────────────
   * @Maya means something specific in this workspace. Resolve those names
   * into the @ImageN citations the engines understand, attaching each one's
   * still after whatever references the request already carried, so a face
   * or a street stays the same shot after shot without being re-described.
   * ------------------------------------------------------------------ */
  let castPrompt = prompt;
  let castUsed: string[] = [];
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
  }

  /* ── Still engines (Nano Banana Pro) ─────────────────────────────────
   * Google renders synchronously and thinks before it draws, so there is no
   * task id to poll: the row goes in as running, the response returns at
   * once, and the render finishes inside after() — the client's ordinary
   * polling picks it up. The prompt goes as written (the cast resolved, a
   * raw: prefix honoured); the model reasons about it itself. A refusal
   * fails the row in Google's own words and is never charged.
   * ------------------------------------------------------------------ */
  if (model.kind === "image") {
    const ratio = model.ratios.includes(body.ratio) ? String(body.ratio) : model.ratios[0];
    const size = model.resolutions.includes(body.resolution)
      ? String(body.resolution) : model.resolutions[0];
    const stillPrompt = castPrompt.replace(/^raw:\s*/i, "");
    const stillProject = body.projectId ? String(body.projectId) : null;
    const stillShot = body.shotId ? String(body.shotId) : null;
    let stillVersion = 1;
    if (stillShot) {
      const shot = await getShot(stillShot);
      if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 400 });
      stillVersion = await nextVersion(stillShot);
    }
    const stillRefs = references.filter((r) => r.kind === "image");
    // The cast just added its stills — the vendor's ceiling counts those too.
    if (stillRefs.length > model.maxReferenceImages) {
      return NextResponse.json({
        error: `${model.label} accepts at most ${model.maxReferenceImages} reference images including cast stills (${stillRefs.length} attached).`,
      }, { status: 400 });
    }
    const genId = id("gen");
    const ts = now();
    const stillParams = {
      ratio, resolution: size,
      references: stillRefs.map((r) => ({ uploadId: r.id, role: r.role, kind: r.kind })),
      rawPrompt: castPrompt !== prompt ? prompt : undefined,
      cast: castUsed.length ? castUsed : undefined,
    };

    await db().execute({
      sql: `INSERT INTO generations
            (id, project_id, ark_task_id, kind, model, prompt, params, status, created_by,
             created_at, updated_at, token_id, shot_id, version, provider, task)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [genId, stillProject, null, "image", modelId, stillPrompt,
             JSON.stringify(stillParams), "running", got.user.id, ts, ts,
             got.token?.id ?? null, stillShot, stillVersion, model.provider, "generate"],
    });
    invalidate(PROJECTS_KEY);

    after(async () => {
      try {
        const img = await generateImage({
          prompt: stillPrompt, ratio, size, references: stillRefs,
        });
        // Google can only emit JPEG; the library keeps PNG. Decode once and
        // re-encode LOSSLESSLY — pixel-identical, and nothing downstream can
        // add generation loss to a PNG. (sharp is for THIS transcode and for
        // delivery copies only — reference masters never pass through it.)
        const sharp = (await import("sharp")).default;
        const png = await sharp(img.bytes).png().toBuffer();
        const storedUrl = await storeImageBytes(genId, png);
        // Google bills flat per image (+ per reference in). Their published
        // figures ARE the ledger; usage tokens are recorded when returned.
        const cost = (IMAGE_OUT_USD[size] ?? 0) + stillRefs.length * IMAGE_REF_IN_USD;
        const tokens = img.totalTokens ?? imageTokens(size, stillRefs.length);
        await db().execute({
          sql: `UPDATE generations
                SET status='succeeded', stored_url=?, total_tokens=?,
                    cost_usd=?, rate_usd_per_m=?, error=NULL, duration_ms=?, updated_at=?
                WHERE id=?`,
          args: [storedUrl, tokens, cost, 120, now() - ts, now(), genId],
        });
      } catch (e) {
        await db().execute({
          sql: `UPDATE generations SET status='failed', error=?, duration_ms=?, updated_at=? WHERE id=?`,
          args: [(e as Error).message.slice(0, 600), now() - ts, now(), genId],
        }).catch(() => {});
      }
      invalidate(PROJECTS_KEY);
    });

    return NextResponse.json({ id: genId, status: "running" });
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
  let refineCost: number | null = null;
  /* ── Library-first composition ───────────────────────────────────────
   * The bank supplies the craft; the author's words stay the author's words.
   * We read what they already specified, fill the rest from the library, and
   * only call a model when there is too little prompt to film at all.
   * ------------------------------------------------------------------ */
  let chosenMove: string | null = null;
  const detected = detectSpec(castPrompt);
  const detectedAxes = Object.values(detected).filter(Boolean).length;
  const refineCall = shouldRefine(castPrompt, detectedAxes);
  if (/^raw:/i.test(castPrompt)) {
    finalPrompt = castPrompt.replace(/^raw:\s*/i, "");
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
      const style = houseStyleBlock(await houseStyle(projectIdForCast));
      const r = await enhancePrompt({
        prompt: castPrompt, citations,
        model: modelId, durationS: params.duration, task: task.id, style,
      });
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
      refineCost = frac * (refineIn * rate.input + refineOut * rate.output) / 1_000_000;
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
  if (shotId) {
    const shot = await getShot(shotId);
    if (!shot) return NextResponse.json({ error: "No such shot." }, { status: 400 });
    version = await nextVersion(shotId);
  }

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
    references: references.map((r) => ({ uploadId: r.id, role: r.role, kind: r.kind })),
    hasVideoInput,
    inputSeconds: hasVideoInput ? inputSeconds : undefined,
    rawPrompt,
    cast: castUsed.length ? castUsed : undefined,
    shotSpec: shotSpec && Object.keys(shotSpec).length ? shotSpec : undefined,
    task: task.id !== "generate" ? task.id : undefined,
    sourceGenId: sourceGenId ?? undefined,
    // What the vendor locked for us, so the record explains its own shape.
    locked: task.locked
      ? { ratio: task.forceRatio, duration: task.forceDuration } : undefined,
  };

  // Row first, so a failed submit is still visible rather than silently lost.
  await db().execute({
    sql: `INSERT INTO generations
          (id, project_id, ark_task_id, model, prompt, params, status, created_by, created_at, updated_at,
           refine_model, refine_in_tokens, refine_out_tokens, refine_cost_usd, token_id,
           shot_id, version, provider, task, source_gen_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [genId, projectId, null, modelId, finalPrompt, JSON.stringify(storedParams), "queued",
           got.user.id, ts, ts,
           refineModel, refineModel ? refineIn : null, refineModel ? refineOut : null, refineCost,
           got.token?.id ?? null,
           shotId, version, model.provider ?? "byteplus", task.id, sourceGenId],
  });

  invalidate(PROJECTS_KEY);

  /* Submitting is the one call that can fail for reasons that aren't ours.
   * A timeout or a 429 is weather and gets tried again with backoff; a
   * rejected prompt is a decision and fails immediately with the vendor's
   * own words. Either way the row already exists, so nothing disappears. */
  const maxRetries = Math.max(0, Math.min(5, Number(await getSetting("maxRetries")) || 0));
  try {
    const { value: taskId, attempts } = await withRetry(
      () => submitTask(modelId, finalPrompt, params, references),
      {
        max: maxRetries,
        onRetry: (n, cls, err) =>
          console.warn(`generate ${genId}: attempt ${n} ${cls} — ${err.message}`),
      }
    );
    await db().execute({
      sql: `UPDATE generations SET ark_task_id=?, status='running', attempts=?, updated_at=? WHERE id=?`,
      args: [taskId, attempts, now(), genId],
    });
    return NextResponse.json({
      id: genId, arkTaskId: taskId, status: "running", attempts,
      notices: notices.length ? notices : undefined,
    });
  } catch (e) {
    const msg = (e as Error).message;
    const cls = classifyFailure(e);
    const shown = cls === "rate-limited"
      ? `The provider is rate-limiting us — try again shortly. (${msg})`
      : msg;
    await db().execute({
      sql: `UPDATE generations SET status='failed', error=?, attempts=?, updated_at=? WHERE id=?`,
      args: [shown, maxRetries + 1, now(), genId],
    });
    return NextResponse.json({ id: genId, status: "failed", error: shown }, { status: 502 });
  }
}
