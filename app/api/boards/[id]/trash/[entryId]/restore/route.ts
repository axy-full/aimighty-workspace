import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { restoreFromTrash } from "@/lib/boardTrash";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; entryId: string }> };

/**
 * Puts one thing back from the board's Trash (lib/boardTrash.ts): a take as it was, a shot with its wires and the takes that were filed under it, or, for
 * what the browser held, the item itself (`payload`) for the browser to put back. Once only. Never touches billing.
 */
export const POST = withTenant(async function POST(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id, entryId } = await params;
  const out = await restoreFromTrash(got.user, id, entryId);
  const headers = { "Cache-Control": "private, no-store" };
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status, headers });
  return NextResponse.json({ entry: out.entry, payload: out.payload }, { headers });
});
