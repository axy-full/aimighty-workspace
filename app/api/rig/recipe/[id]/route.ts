import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { recipeOf, createRecipe, DEFAULT_STAGES, type NewStage } from "@/lib/runs";

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
export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  if (await recipeOf(id)) {
    return NextResponse.json({ error: "This project already has a recipe." }, { status: 409 });
  }
  /* `Save as recipe` on the Canvas (design/particl-v2 §8) sends the board's
     generate nodes as stages — name, engine, units, credits, and which
     stages feed which; with no body the eight default stages are written. */
  const b = await req.json().catch(() => ({}));
  const sent: NewStage[] = Array.isArray(b?.stages) ? b.stages.filter((s: unknown) => s && typeof s === "object").map((s: Record<string, unknown>, i: number): NewStage => ({
    num: Number(s.num ?? i + 1), name: String(s.name ?? `Stage ${i + 1}`).slice(0, 60),
    kind: s.kind === "write" || s.kind === "assemble" ? s.kind : "render",
    engine: typeof s.engine === "string" ? s.engine.slice(0, 60) : undefined,
    units: Math.max(1, Math.round(Number(s.units ?? 1)) || 1), credits: Math.max(0, Number(s.credits ?? 0) || 0),
    inputs: Array.isArray(s.inputs) ? s.inputs.map(Number).filter(Number.isFinite) : [],
  })).slice(0, 40) : [];
  const name = typeof b?.name === "string" && b.name.trim() ? b.name.trim() : "Production";
  await createRecipe(id, name, sent.length ? sent : DEFAULT_STAGES, got.user.id);
  return NextResponse.json({ recipe: await recipeOf(id) }, { status: 201 });
});
