import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { restoreFromWorkspaceTrash } from "@/lib/boardTrash";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ entryId: string }> };

/** Puts a take back from the workspace's Trash, as it was (lib/boardTrash.ts). Once only. Never touches billing. */
export const POST = withTenant(async function POST(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { entryId } = await params;
  const out = await restoreFromWorkspaceTrash(got.user, entryId);
  const headers = { "Cache-Control": "private, no-store" };
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status, headers });
  return NextResponse.json({ entry: out.entry }, { headers });
});
