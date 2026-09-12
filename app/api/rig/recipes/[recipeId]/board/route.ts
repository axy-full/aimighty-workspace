import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { recipeToBoard, projectExists } from "@/lib/runs";

/** `Open as a board` (SOW surfaces 12d): the board the recipe was saved from, or one laid out from its stages. Building is free. */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ recipeId: string }> };

export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { recipeId } = await params;
  const b = await req.json().catch(() => ({}));
  const projectId = typeof b?.projectId === "string" && b.projectId ? b.projectId : null;
  if (!projectId) return NextResponse.json({ error: "Which project's board?" }, { status: 400 });
  if (!(await projectExists(projectId))) return NextResponse.json({ error: "No such project." }, { status: 404 });
  const boardId = await recipeToBoard(recipeId, projectId);
  if (!boardId) return NextResponse.json({ error: "No such recipe." }, { status: 404 });
  return NextResponse.json({ boardId }, { status: 201 });
});
