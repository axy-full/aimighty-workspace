import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { submitTask, type VideoParams, type Reference, type ImageRole } from "@/lib/ark";
import { getModel, DEFAULT_MODEL_ID } from "@/lib/models";
import { enhancePrompt, TEXT_RATES, TEXT_RATE_FALLBACK, TEXT_FREE_TOKENS } from "@/lib/enhance";
import { requireRender, tokenSpendThisMonth } from "@/lib/auth";
import { invalidate, PROJECTS_KEY } from "@/lib/cache";

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

  const params: VideoParams = {
    ratio: model.ratios.includes(body.ratio) ? body.ratio : model.ratios[0],
    resolution: model.resolutions.includes(body.resolution) ? body.resolution : model.resolutions[0],
    duration: model.durations.includes(Number(body.duration))
      ? Number(body.duration) : model.durations[0],
    watermark: Boolean(body.watermark ?? false),
    seed: body.seed === "" || body.seed == null ? null : Number(body.seed),
    cameraFixed: Boolean(body.cameraFixed ?? false),
    generateAudio: model.supportsAudio ? Boolean(body.generateAudio ?? false) : false,
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

  let references: Reference[] = [];
  let inputSeconds = 0;
  if (wanted.length) {
    const placeholders = wanted.map(() => "?").join(",");
    const rs = await db().execute({
      sql: `SELECT id, mime, ext, stored_url, kind, duration_s FROM uploads WHERE id IN (${placeholders})`,
      args: wanted.map((w) => w.uploadId),
    });
    const byId = new Map(
      rs.rows.map((r) => {
        const row = r as unknown as {
          id: string; mime: string; ext: string; stored_url: string;
          kind: string; duration_s: number | null;
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
      };
    });
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
  let finalPrompt = prompt;
  let rawPrompt: string | undefined;
  let refineModel: string | null = null;
  let refineIn = 0, refineOut = 0;
  let refineCost: number | null = null;
  if (/^raw:/i.test(prompt)) {
    finalPrompt = prompt.replace(/^raw:\s*/i, "");
  } else if (!prompt.includes("【")) {
    const citations = [
      ...references.filter((r) => r.kind === "image" && r.role === "reference_image")
        .map((_, i) => `@Image${i + 1} (image)`),
      ...references.filter((r) => r.role === "first_frame").map(() => "a first-frame image"),
      ...references.filter((r) => r.role === "last_frame").map(() => "a last-frame image"),
      ...references.filter((r) => r.kind === "video").map((_, i) => `@Video${i + 1} (video)`),
    ];
    try {
      const r = await enhancePrompt({ prompt, citations });
      finalPrompt = r.text;
      rawPrompt = prompt;
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
      const freeLeft = Math.max(0, TEXT_FREE_TOKENS - usedBefore);
      const billable = Math.max(0, rowTokens - freeLeft);
      const frac = rowTokens > 0 ? billable / rowTokens : 0;
      const rate = TEXT_RATES[refineModel] ?? TEXT_RATE_FALLBACK;
      refineCost = frac * (refineIn * rate.input + refineOut * rate.output) / 1_000_000;
    } catch (e) {
      console.error("auto-refine unavailable, rendering raw:", (e as Error).message);
    }
  }

  const projectId = body.projectId ? String(body.projectId) : null;
  const genId = id("gen");
  const ts = now();
  const hasVideoInput = references.some((r) => r.kind === "video");
  const storedParams = {
    ...params,
    references: references.map((r) => ({ uploadId: r.id, role: r.role, kind: r.kind })),
    hasVideoInput,
    inputSeconds: hasVideoInput ? inputSeconds : undefined,
    rawPrompt,
  };

  // Row first, so a failed submit is still visible rather than silently lost.
  await db().execute({
    sql: `INSERT INTO generations
          (id, project_id, ark_task_id, model, prompt, params, status, created_by, created_at, updated_at,
           refine_model, refine_in_tokens, refine_out_tokens, refine_cost_usd, token_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [genId, projectId, null, modelId, finalPrompt, JSON.stringify(storedParams), "queued",
           got.user.id, ts, ts,
           refineModel, refineModel ? refineIn : null, refineModel ? refineOut : null, refineCost,
           got.token?.id ?? null],
  });

  invalidate(PROJECTS_KEY);
  try {
    const taskId = await submitTask(modelId, finalPrompt, params, references);
    await db().execute({
      sql: `UPDATE generations SET ark_task_id=?, status='running', updated_at=? WHERE id=?`,
      args: [taskId, now(), genId],
    });
    return NextResponse.json({ id: genId, arkTaskId: taskId, status: "running" });
  } catch (e) {
    const msg = (e as Error).message;
    await db().execute({
      sql: `UPDATE generations SET status='failed', error=?, updated_at=? WHERE id=?`,
      args: [msg, now(), genId],
    });
    return NextResponse.json({ id: genId, status: "failed", error: msg }, { status: 502 });
  }
}
