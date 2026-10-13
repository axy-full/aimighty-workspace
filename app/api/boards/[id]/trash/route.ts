import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listTrash, removeToTrash } from "@/lib/boardTrash";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * A board's Trash (lib/boardTrash.ts). `id` is the board's project id.
 *  GET   the Trash, newest first: kind, label, who removed it, whether it can still be put back. For people who can edit the board only; any other
 *        board is as absent as an unknown one.
 *  POST  { kind, itemId, label?, payload? }  removes a take or a shot (the server does it) or records what the browser removed (a card, note, text, frame,
 *        look, beat, cast entry...: `payload` is the item, whole). Nothing is erased and nothing here touches billing.
 */
export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const out = await listTrash(got.user, id);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status, headers: NO_STORE });
  return NextResponse.json({ items: out.items }, { headers: NO_STORE });
});

export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { kind?: unknown; itemId?: unknown; label?: unknown; payload?: unknown };
  const out = await removeToTrash(got.user, id, body);
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status, headers: NO_STORE });
  return NextResponse.json({ entry: out.entry }, { headers: NO_STORE });
});
