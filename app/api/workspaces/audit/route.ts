import { requireAdmin, withTenant } from "@/lib/auth";
import { db, ready } from "@/lib/db";
import { platformDb, platformReady } from "@/lib/platform";
import { requireTenant } from "@/lib/tenant";
import { parseAuditCursor, readWorkspaceSecurityHistory } from "@/lib/securityAudit";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export const GET = withTenant(async (req: Request) => {
  const auth = await requireAdmin();
  if (auth.response) return auth.response;
  const workspace = requireTenant();
  if (workbenchScopeProblem(req, workspace.id, auth.user.id, true))
    return Response.json({ error: "Your account or workspace changed. Reload settings before viewing activity." }, { status: 409, headers });
  const query = new URL(req.url).searchParams;
  const limit = Number(query.get("limit") ?? 30);
  let before;
  try {
    before = parseAuditCursor(query.get("before"));
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page");
  } catch {
    return Response.json({ error: "Invalid activity page." }, { status: 400, headers });
  }
  try {
    await Promise.all([ready(), platformReady()]);
    const result = await readWorkspaceSecurityHistory([platformDb(), db()], workspace.id, limit, before);
    const ids = [...new Set(result.events.flatMap((event) => [...(event.actorId ? [event.actorId] : []), ...(["account", "member"].includes(event.targetType) && event.targetId ? [event.targetId] : [])]))];
    const actors: Record<string, string> = {};
    if (ids.length) {
      const rows = await platformDb().execute({
        sql: `SELECT a.id,a.name FROM accounts a JOIN memberships m ON m.account_id=a.id
          WHERE m.workspace_id=? AND a.deleted_at IS NULL AND a.id IN (${ids.map(() => "?").join(",")})`,
        args: [workspace.id, ...ids],
      });
      for (const row of rows.rows) actors[String(row.id)] = String(row.name);
    }
    return Response.json({ ...result, actors }, { headers });
  } catch {
    console.error(JSON.stringify({ event: "security_history_read_failed" }));
    return Response.json({ error: "Activity is temporarily unavailable. Try again shortly." }, { status: 503, headers });
  }
});
