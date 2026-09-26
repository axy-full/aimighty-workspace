import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady } from "@/lib/platform";
import { archiveAndDelete } from "@/lib/archive";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/**
 * Withdraw an invitation that hasn't been used. The link stops working at
 * once, but the row (who was asked, by whom, as what) is kept whole in the
 * platform database's archive, never erased (lib/archive.ts).
 */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const { code } = await params;
  await archiveAndDelete(platformDb(), "workspace_invites", "code = ? AND workspace_id = ? AND used_at IS NULL", [code, ws.id], { reason: "invite revoked", by: got.user.id });
  return NextResponse.json({ ok: true });
}, { requireRequestScope: true });
