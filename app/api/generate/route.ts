import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { submitTask, type VideoParams, type Reference, type ImageRole } from "@/lib/ark";
import { getModel, DEFAULT_MODEL_ID } from "@/lib/models";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const ROLES: ImageRole[] = ["first_frame", "last_frame", "reference_image"];

/**
 * ModelArk treats these as mutually exclusive scenarios:
 *   • image-to-video (first frame, and optionally last frame) — max 2 images
 *   • omni reference-to-video — 1..maxReferenceImages
 * They cannot be mixed in one request.
 */
function validateReferences(
  refs: { role: ImageRole }[], maxReference: number
): string | null {
  if (!refs.length) return null;

  const frames = refs.filter((r) => r.role === "first_frame" || r.role === "last_frame");
  const references = refs.filter((r) => r.role === "reference_image");

  if (frames.length && references.length) {
    return "First/last frame and reference images can't be mixed — ModelArk treats them as separate modes.";
  }
  if (frames.length) {
    if (frames.filter((r) => r.role === "first_frame").length > 1) return "Only one first frame.";
    if (frames.filter((r) => r.role === "last_frame").length > 1) return "Only one last frame.";
    if (!frames.some((r) => r.role === "first_frame")) {
      return "A last frame needs a first frame alongside it.";
    }
  }
  if (references.length > maxReference) {
    return `This model accepts at most ${maxReference} reference images (${references.length} attached).`;
  }
  return null;
}

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
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

  const refProblem = validateReferences(wanted, model.maxReferenceImages);
  if (refProblem) return NextResponse.json({ error: refProblem }, { status: 400 });

  let references: Reference[] = [];
  if (wanted.length) {
    const placeholders = wanted.map(() => "?").join(",");
    const rs = await db().execute({
      sql: `SELECT id, mime, ext, stored_url FROM uploads WHERE id IN (${placeholders})`,
      args: wanted.map((w) => w.uploadId),
    });
    const byId = new Map(
      rs.rows.map((r) => {
        const row = r as unknown as { id: string; mime: string; ext: string; stored_url: string };
        return [row.id, row];
      })
    );
    const missing = wanted.filter((w) => !byId.has(w.uploadId));
    if (missing.length) {
      return NextResponse.json({ error: "A reference image is no longer available." }, { status: 400 });
    }
    // Preserve the order the user arranged — @Image1 is the first in the list.
    references = wanted.map((w) => {
      const row = byId.get(w.uploadId)!;
      return { id: row.id, mime: row.mime, ext: row.ext, storedUrl: row.stored_url, role: w.role };
    });
  }

  const projectId = body.projectId ? String(body.projectId) : null;
  const genId = id("gen");
  const ts = now();
  const storedParams = { ...params, references: wanted };

  // Row first, so a failed submit is still visible rather than silently lost.
  await db().execute({
    sql: `INSERT INTO generations
          (id, project_id, ark_task_id, model, prompt, params, status, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [genId, projectId, null, modelId, prompt, JSON.stringify(storedParams), "queued",
           got.user.id, ts, ts],
  });

  try {
    const taskId = await submitTask(modelId, prompt, params, references);
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
