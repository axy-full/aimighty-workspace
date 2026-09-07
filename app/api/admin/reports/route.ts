import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { platformDb, platformReady, now } from "@/lib/platform";

export const dynamic = "force-dynamic";

/** The desk's reports: open ones first, then what was handled lately. */
export async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const rs = await platformDb().execute(`
    SELECT r.*, w.name AS workspace_name, w.slug AS workspace_slug, a.email AS account_email
    FROM reports r LEFT JOIN workspaces w ON w.id = r.workspace_id LEFT JOIN accounts a ON a.id = r.account_id
    ORDER BY (r.handled_at IS NULL) DESC, r.created_at DESC LIMIT 100`);
  const rows = (rs.rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), url: String(r.url), reason: String(r.reason), details: String(r.details ?? ""), email: (r.email as string | null) ?? null,
    workspace: r.workspace_id ? { id: String(r.workspace_id), name: String(r.workspace_name ?? ""), slug: String(r.workspace_slug ?? "") } : null,
    accountEmail: (r.account_email as string | null) ?? null, createdAt: Number(r.created_at), handledAt: r.handled_at == null ? null : Number(r.handled_at),
  }));
  return NextResponse.json({ open: rows.filter((r) => !r.handledAt), handled: rows.filter((r) => r.handledAt) });
}

/** Mark one handled. */
export async function PATCH(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "id is needed." }, { status: 400 });
  await platformReady();
  await platformDb().execute({ sql: `UPDATE reports SET handled_at = ?, handled_by = ? WHERE id = ? AND handled_at IS NULL`, args: [now(), got.user.id, String(body.id)] });
  return NextResponse.json({ ok: true });
}
