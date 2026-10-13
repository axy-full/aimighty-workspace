import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { sampleWriteRefusal } from "@/lib/demo/readonly.server";
import { mayReachProject } from "@/lib/draftProject";
import { NOT_YOURS, mayChangeProject } from "@/lib/workAccess";

export const dynamic = "force-dynamic";

/**
 * "Send changes to Particl". Atomik and Particl share one database, so
 * there is nothing to copy: sending is the moment the producer says the
 * list is what they mean, which clears the edited-since-last-send tint and
 * stamps the time the status line reports.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const body = await req.json().catch(() => ({}));
  const projectId = body.projectId ? String(body.projectId) : null;
  if (!projectId) return NextResponse.json({ error: "Which production?" }, { status: 400 });
  /* The marked sample takes no send, from anyone (lib/demo/readonly.server.ts). */
  { const refused = await sampleWriteRefusal(projectId); if (refused) return refused; }
  /* A private board is its owner's to write (lib/draftProject.ts), and asking comes before the rule about who may change work: to anyone else it is answered as a project that is not there, which has nothing to send. */
  if (!(await mayReachProject(got.user, projectId, "write"))) return NextResponse.json({ ok: true, sent: 0, at: now() });
  /* Sending a project's list across is its owner's or an admin's (lib/workAccess.ts); an unknown project is answered as it always was. */
  if ((await db().execute({ sql: `SELECT 1 FROM projects WHERE id = ?`, args: [projectId] })).rows.length && !(await mayChangeProject(got.user, projectId)))
    return NextResponse.json({ error: NOT_YOURS.project }, { status: 403 });
  const ts = now();
  const rs = await db().execute({
    sql: `UPDATE shots SET dirty = 0, synced_at = ? WHERE project_id = ?`,
    args: [ts, projectId],
  });
  return NextResponse.json({ ok: true, sent: Number(rs.rowsAffected ?? 0), at: ts });
});
