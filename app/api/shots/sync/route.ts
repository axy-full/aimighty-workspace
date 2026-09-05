import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * "Send changes to Particl". Atomik and Particl share one database, so
 * there is nothing to copy: sending is the moment the producer says the
 * list is what they mean, which clears the edited-since-last-send tint and
 * stamps the time the status line reports.
 */
export async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));
  const projectId = body.projectId ? String(body.projectId) : null;
  if (!projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  const ts = now();
  const rs = await db().execute({
    sql: `UPDATE shots SET dirty = 0, synced_at = ? WHERE project_id = ?`,
    args: [ts, projectId],
  });
  return NextResponse.json({ ok: true, sent: Number(rs.rowsAffected ?? 0), at: ts });
}
