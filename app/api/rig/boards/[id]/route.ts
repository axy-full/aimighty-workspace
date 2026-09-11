import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { getBoard, saveBoard } from "@/lib/boards";

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

/** The graph, whole. Nodes and wires are the browser's to arrange; the server keeps them. */
export const PUT = withTenant(async function PUT(req: Request, ctx: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const board = await saveBoard(id, {
    name: typeof b.name === "string" ? b.name : undefined,
    nodes: Array.isArray(b.nodes) ? b.nodes : undefined,
    wires: Array.isArray(b.wires) ? b.wires : undefined,
  });
  if (!board) return NextResponse.json({ error: "No such board." }, { status: 404 });
  return NextResponse.json({ board });
});
