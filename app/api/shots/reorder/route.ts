import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { db, ready, now } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The grid's order IS the sequence (design/particl-v2 §7): dragging a card
 * onto another reorders, and the filmstrip follows. One write per shot,
 * positions 0…n in the order given, scoped to one project so a stray id
 * from another cannot be pulled in.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const b = await req.json().catch(() => ({}));
  const projectId = typeof b.projectId === "string" ? b.projectId : "";
  const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String) : [];
  if (!projectId || !ids.length) return NextResponse.json({ error: "A project and its shots, in order." }, { status: 400 });
  const rs = await db().execute({ sql: `SELECT id FROM shots WHERE project_id = ?`, args: [projectId] });
  const own = new Set(rs.rows.map((r) => String((r as unknown as { id: unknown }).id)));
  if (!ids.every((id) => own.has(id))) return NextResponse.json({ error: "Those are not all this project's shots." }, { status: 400 });
  const at = now();
  for (let i = 0; i < ids.length; i++) {
    await db().execute({ sql: `UPDATE shots SET position = ?, updated_at = ? WHERE id = ?`, args: [i, at, ids[i]] });
  }
  return NextResponse.json({ ok: true });
});
