import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { forkRecipe, projectExists } from "@/lib/runs";

/** `Copy and change` (SOW surfaces 12d): the same stages as the workspace's own recipe, under a project, ready to edit. Free. */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ recipeId: string }> };

export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { recipeId } = await params;
  const b = await req.json().catch(() => ({}));
  const projectId = typeof b?.projectId === "string" && b.projectId ? b.projectId : null;
  if (!projectId) return NextResponse.json({ error: "Which project should the copy belong to?" }, { status: 400 });
  if (!(await projectExists(projectId))) return NextResponse.json({ error: "No such project." }, { status: 404 });
  const id = await forkRecipe(recipeId, projectId, got.user.id);
  if (!id) return NextResponse.json({ error: "No such recipe." }, { status: 404 });
  return NextResponse.json({ id }, { status: 201 });
});
