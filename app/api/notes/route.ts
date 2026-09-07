import { NextResponse } from "next/server";
import { db, ready, now, id } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Notes on one shot — review talk that belongs beside the clip rather than
 *  scrolling away in the workspace chat. */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const genId = new URL(req.url).searchParams.get("genId");
  if (!genId) return NextResponse.json({ error: "Which render?" }, { status: 400 });

  /* The team's notes and the client's comments from a review link, as one
     conversation on the take (brief 2.6): a note belongs to a user and a
     client has no account here, so they are kept apart and read together. */
  const rs = await db().execute({
    sql: `SELECT n.id, n.gen_id, n.user_id, n.text, n.created_at, u.name AS author, 0 AS guest
          FROM notes n JOIN users u ON u.id = n.user_id WHERE n.gen_id = ?
          UNION ALL
          SELECT r.id, r.gen_id, '' AS user_id, r.text, r.created_at, r.guest AS author, 1 AS guest
          FROM review_notes r WHERE r.gen_id = ?
          ORDER BY created_at`,
    args: [genId, genId],
  });
  return NextResponse.json({
    notes: rs.rows.map((r: any) => ({
      id: r.id, text: r.text, author: r.author,
      userId: r.user_id, createdAt: Number(r.created_at),
      /** A comment from a client review link, not one of the team's own. */
      guest: Number(r.guest) === 1,
    })),
  });
});

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));
  const genId = String(body.genId ?? "");
  const text = String(body.text ?? "").trim().slice(0, 2000);
  if (!genId || !text) return NextResponse.json({ error: "A note needs a shot and some words" }, { status: 400 });

  await db().execute({
    sql: `INSERT INTO notes (id, gen_id, user_id, text, created_at) VALUES (?,?,?,?,?)`,
    args: [id("note"), genId, got.user.id, text, now()],
  });
  return NextResponse.json({ ok: true });
});
