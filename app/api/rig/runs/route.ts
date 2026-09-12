import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { recipeOf, recipeById, startRun, shotCount, projectExists } from "@/lib/runs";

export const dynamic = "force-dynamic";

/**
 * Start a run of a project's recipe (§9): every stage priced as the recipe
 * has it, nothing charged until a stage renders. The run stops at its first
 * checkpoint — a rendering stage — for a person to continue.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();   // a run spends: the render door, not the read one
  if (got.response) return got.response;
  const b = await req.json().catch(() => ({}));
  const projectId = typeof b.projectId === "string" ? b.projectId : "";
  if (!projectId) return NextResponse.json({ error: "Which project?" }, { status: 400 });
  if (!(await projectExists(projectId))) return NextResponse.json({ error: "No such project." }, { status: 404 });
  /* SOW surfaces 12d: any recipe the workspace can see runs on any of its projects — a platform one, or another project's —
     priced for THIS project's shots the way the button quoted it (fSOW §6.3: prices recomputed). */
  const shots = await shotCount(projectId);
  const recipe = typeof b.recipeId === "string" && b.recipeId ? await recipeById(b.recipeId, { shots, projectId }) : await recipeOf(projectId, { shots });
  if (!recipe) return NextResponse.json({ error: "This project has no recipe yet. Save a board as one first." }, { status: 404 });
  if (!recipe.stages.length) return NextResponse.json({ error: "That recipe has no steps to run." }, { status: 400 });
  /* A count that follows the shot list has nothing to count on a project with no shots: nothing to queue, nothing to charge. */
  if (recipe.stages.some((s) => s.perShot && s.totalUnits === 0)) return NextResponse.json({ error: "This project has no shots yet." }, { status: 400 });
  const runId = await startRun(recipe.id, projectId, recipe.stages.map((s) => ({ stageId: s.id, units: s.totalUnits || 1, credits: s.credits })), got.user.id);
  return NextResponse.json({ id: runId }, { status: 201 });
});
