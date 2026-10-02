import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, requireUser, withTenant } from "@/lib/auth";
import { getBoard, saveBoard, saveBoardIfCurrent } from "@/lib/boards";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { TeamCanvasError } from "@/lib/workbench/team-canvas";
import { importBoardBatch } from "@/lib/workbench/board-import";

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

const NO_STORE = { "Cache-Control": "no-store" };
const importSchema = z.object({ action: z.literal("import"), productionId: z.string().max(100) });

/**
 * `import`: opens this board in the new Rig. Its next batch of cards and inputs
 * comes across onto the team canvas of `productionId`, which must be the
 * board's own production. One bounded batch per call (lib/workbench/board-import.ts);
 * call again until `done`. It is idempotent and resumable, and free. The board itself is only read.
 * It writes a team canvas, so it carries the same account and workspace scope
 * as every canvas write.
 */
export const POST = withTenant(async function POST(req: Request, ctx: Ctx) {
  /* A person in a browser, like every other team canvas write: an API token cannot. */
  const got = await requireSession();
  if (got.response) return got.response;
  const scopeError = workbenchScopeProblem(req, requireTenant().id, got.user.id, true);
  if (scopeError) return NextResponse.json({ error: scopeError }, { status: 409, headers: NO_STORE });
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  const { id } = await ctx.params;
  const parsed = importSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) return NextResponse.json({ error: "Check the board action before sending it." }, { status: 400, headers: NO_STORE });
  try {
    return NextResponse.json(await importBoardBatch(parsed.data.productionId, id, got.user.id), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof TeamCanvasError) return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    throw error;
  }
});
