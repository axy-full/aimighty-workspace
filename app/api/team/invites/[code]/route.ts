import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady } from "@/lib/platform";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/** Withdraw an invitation that hasn't been used. */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const { code } = await params;
  await platformDb().execute({ sql: `DELETE FROM workspace_invites WHERE code = ? AND workspace_id = ? AND used_at IS NULL`, args: [code, ws.id] });
  return NextResponse.json({ ok: true });
});
