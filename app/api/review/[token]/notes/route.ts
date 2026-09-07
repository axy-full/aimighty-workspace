import { NextResponse } from "next/server";
import { runInTenant } from "@/lib/tenant";
import { resolveShare } from "@/lib/shares";
import { db, ready, now, id as newId } from "@/lib/db";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ token: string }> };

/**
 * A client's comment, written back to the take's notes (brief 2.6). It is
 * kept apart from the team's notes because a note belongs to a user and a
 * client has no account here — the take shows both as one conversation.
 */
export const POST = async function POST(req: Request, { params }: Ctx) {
  const { token } = await params;
  const found = await resolveShare(token);
  if (!found) return NextResponse.json({ error: "This review link has expired or been withdrawn." }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const genId = String(body.genId ?? "");
  const text = String(body.text ?? "").trim().slice(0, 2000);
  const guest = String(body.name ?? "").trim().slice(0, 60) || "the client";
  if (!genId || !text) return NextResponse.json({ error: "A comment needs a take and some words." }, { status: 400 });

  const ok = await runInTenant(found.workspace, async () => {
    await ready();
    const rs = await db().execute({
      sql: `SELECT 1 FROM generations WHERE id = ? AND project_id = ? AND review_state = 'approved' AND deleted = 0 LIMIT 1`,
      args: [genId, found.share.projectId],
    });
    if (!rs.rows.length) return false;
    await db().execute({
      sql: `INSERT INTO review_notes (id, gen_id, share_id, guest, text, created_at) VALUES (?,?,?,?,?,?)`,
      args: [newId("rnote"), genId, found.share.id, guest, text, now()],
    });
    return true;
  });
  if (!ok) return NextResponse.json({ error: "Not part of this review." }, { status: 404 });
  return NextResponse.json({ ok: true, author: guest }, { status: 201 });
};
