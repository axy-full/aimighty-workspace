import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * R3 — the shared project canvas.
 *
 * Layout is stored apart from the generation row on purpose: moving a card
 * around a board must never touch production data, and a board has to be able
 * to hold things that aren't renders — a reference still, a note, a heading
 * over a sequence. Everyone on a project sees the same board; it's polled
 * rather than pushed, which is enough for a room of six.
 */
export async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const rs = await db().execute({
    sql: `SELECT c.*, u.name AS author_name,
                 g.status AS gen_status, g.stored_url AS gen_url, g.kind AS gen_kind,
                 g.prompt AS gen_prompt, g.version AS gen_version,
                 s.code AS shot_code, s.scene AS shot_scene,
                 up.stored_url AS upload_url, up.mime AS upload_mime
          FROM canvas_items c
          LEFT JOIN users u  ON u.id = c.created_by
          LEFT JOIN generations g ON g.id = c.ref_id AND c.kind = 'generation' AND g.deleted = 0
          LEFT JOIN shots s  ON s.id = g.shot_id
          LEFT JOIN uploads up ON up.id = c.ref_id AND c.kind = 'upload'
          WHERE c.project_id = ?
          ORDER BY c.z, c.created_at`,
    args: [projectId],
  });

  return NextResponse.json({
    items: rs.rows.map((r: any) => ({
      id: r.id, kind: r.kind, refId: r.ref_id ?? null, text: r.text ?? "",
      x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h),
      z: Number(r.z), colour: r.colour ?? "",
      authorName: r.author_name ?? null, updatedAt: Number(r.updated_at),
      gen: r.gen_status ? {
        status: r.gen_status, url: r.gen_url, kind: r.gen_kind === "image" ? "image" : "video",
        prompt: r.gen_prompt, version: Number(r.gen_version ?? 1),
        shot: r.shot_code ? `${r.shot_scene ? `${r.shot_scene} · ` : ""}${r.shot_code}` : null,
      } : null,
      upload: r.upload_url ? { url: r.upload_url, mime: r.upload_mime } : null,
    })),
  });
}

export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));
  const projectId = String(body.projectId ?? "");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const kind = ["generation", "upload", "note", "heading"].includes(body.kind) ? body.kind : "note";
  const ts = now();

  // Stack a new card on top of whatever is already there.
  const top = await db().execute({
    sql: `SELECT COALESCE(MAX(z),0) AS z FROM canvas_items WHERE project_id = ?`,
    args: [projectId],
  });
  const z = Number((top.rows[0] as any)?.z ?? 0) + 1;

  // The same render is only ever on the board once — dropping it twice
  // should move the card you already have, not stack a duplicate under it.
  if (kind === "generation" || kind === "upload") {
    const dupe = await db().execute({
      sql: `SELECT id FROM canvas_items WHERE project_id = ? AND kind = ? AND ref_id = ? LIMIT 1`,
      args: [projectId, kind, String(body.refId ?? "")],
    });
    if (dupe.rows.length) {
      return NextResponse.json({ id: (dupe.rows[0] as any).id, existing: true });
    }
  }

  const cid = id("cv");
  await db().execute({
    sql: `INSERT INTO canvas_items
            (id, project_id, kind, ref_id, text, x, y, w, h, z, colour, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [cid, projectId, kind, body.refId ? String(body.refId) : null,
           String(body.text ?? "").slice(0, 2000),
           Number(body.x ?? 0), Number(body.y ?? 0),
           Number(body.w ?? (kind === "heading" ? 320 : 260)),
           Number(body.h ?? (kind === "note" ? 140 : kind === "heading" ? 56 : 190)),
           z, String(body.colour ?? ""), got.user.id, ts, ts],
  });
  return NextResponse.json({ id: cid });
}
