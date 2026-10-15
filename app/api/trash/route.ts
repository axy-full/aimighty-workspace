import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listWorkspaceTrash } from "@/lib/boardTrash";

export const dynamic = "force-dynamic";

/**
 * The workspace's Trash (lib/boardTrash.ts): the takes removed that were filed on no board. The person who removed one lists it; an admin lists the ones they may
 * change; nobody else. (A board's Trash is /api/boards/[id]/trash.)
 */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const out = await listWorkspaceTrash(got.user);
  return NextResponse.json({ items: out.items }, { headers: { "Cache-Control": "private, no-store" } });
});
