import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { recipeOf, startRun } from "@/lib/runs";

export const dynamic = "force-dynamic";

/**
 * Start a run of a project's recipe (§9): every stage priced as the recipe
 * has it, nothing charged until a stage renders. The run stops at its first
 * checkpoint — a rendering stage — for a person to continue.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const b = await req.json().catch(() => ({}));
  const projectId = typeof b.projectId === "string" ? b.projectId : "";
  if (!projectId) return NextResponse.json({ error: "Which project?" }, { status: 400 });
  const recipe = await recipeOf(projectId);
  if (!recipe) return NextResponse.json({ error: "This project has no recipe yet. Save a board as one first." }, { status: 404 });
  const runId = await startRun(recipe.id, projectId, recipe.stages.map((s) => ({ stageId: s.id, units: s.totalUnits || 1, credits: s.credits })), got.user.id);
  return NextResponse.json({ id: runId }, { status: 201 });
});
