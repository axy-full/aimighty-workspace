import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { workspaceSheet } from "@/lib/platformConsole.server";

export const dynamic = "force-dynamic";

/**
 * One workspace for the platform console's side sheet: its plan, people, credit history and the owner's own changes to it.
 * Changing a workspace (credits, pause, resume) is the desk's own route, app/api/admin/workspaces/[id]; this only reads.
 * The platform owner only, in a browser session.
 */
export const GET = recoveryRoute(async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const { id } = await params;
  const sheet = await workspaceSheet(id);
  if (!sheet) return NextResponse.json({ error: "No such workspace." }, { status: 404 });
  return NextResponse.json(sheet, { headers: { "Cache-Control": "no-store" } });
});
