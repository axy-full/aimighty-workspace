import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { recipeOf, createRecipe, DEFAULT_STAGES } from "@/lib/runs";

/**
 * A production's recipe as a graph (brief 3, surface 1d).
 *
 * The id is the production's. A recipe with no run yet answers with every
 * stage queued, which is what it is.
 *
 * POST WRITES ONE. Until it existed the node layer could not be filled by
 * anybody: `createRecipe` was implemented and had zero callers, the route was
 * GET-only, and the three tables behind it had never held a row — so Stages
 * and Runs both rendered their empty state permanently, and the whole surface
 * read as unbuilt.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  return NextResponse.json({ recipe: await recipeOf(id) });
});

/**
 * Write this production's recipe, from the eight stages §9 names.
 *
 * Refuses when one already exists rather than making a second: `recipeOf`
 * takes the most recently updated, so a duplicate would quietly become the
 * production's recipe and orphan the first along with any run painted onto
 * it. Nothing here edits stages yet — this is the empty case only.
 */
export const POST = withTenant(async function POST(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  if (await recipeOf(id)) {
    return NextResponse.json({ error: "This production already has a recipe." }, { status: 409 });
  }
  await createRecipe(id, "Production", DEFAULT_STAGES, got.user.id);
  return NextResponse.json({ recipe: await recipeOf(id) }, { status: 201 });
});
