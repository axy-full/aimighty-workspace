import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { getBoard, saveBoard, saveBoardIfCurrent } from "@/lib/boards";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: Request, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const board = await getBoard(id);
  if (!board) return NextResponse.json({ error: "No such board." }, { status: 404 });
  return NextResponse.json({ board });
});

/**
 * The graph, whole. Nodes and wires are the browser's to arrange; the server
 * keeps them. A write that says which revision it was edited from
 * (`baseUpdatedAt`) is refused with 409, `conflict: true` and the board as it
 * stands when that revision is no longer current, instead of overwriting
 * whoever saved since. (A 409 without `conflict` is a media reference that is
 * gone, from withTenant.)
 */
export const PUT = withTenant(async function PUT(req: Request, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const patch = {
    name: typeof b.name === "string" ? b.name : undefined,
    nodes: Array.isArray(b.nodes) ? b.nodes : undefined,
    wires: Array.isArray(b.wires) ? b.wires : undefined,
  };
  const base = typeof b.baseUpdatedAt === "number" && Number.isFinite(b.baseUpdatedAt) ? b.baseUpdatedAt : null;
  if (base == null) {
    const board = await saveBoard(id, patch);
    if (!board) return NextResponse.json({ error: "No such board." }, { status: 404 });
    return NextResponse.json({ board });
  }
  const saved = await saveBoardIfCurrent(id, patch, base);
  if (!saved) return NextResponse.json({ error: "No such board." }, { status: 404 });
  if ("conflict" in saved) return NextResponse.json({ error: "Someone else changed this board. Reload to see it.", conflict: true, board: saved.conflict }, { status: 409 });
  return NextResponse.json({ board: saved.board });
});
