import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { recipeById, updateRecipe, shotCount, projectExists, type StagePatch } from "@/lib/runs";
import { isStageMode } from "@/lib/runState";

/**
 * One recipe by its own id (SOW surfaces 12d): the graph with each stage's
 * engine and vendor from the registry, its unit price, its Atomik mode.
 * PATCH changes the name, the blurb, and per stage the engine, the mode,
 * the cap or the count; a new engine re-prices the stage from the rate
 * table. A platform recipe is read-only here — `Copy and change` forks it.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ recipeId: string }> };

export const GET = withTenant(async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { recipeId } = await params;
  const wanted = new URL(req.url).searchParams.get("project");
  const projectId = wanted && (await projectExists(wanted)) ? wanted : null;
  const shots = projectId ? await shotCount(projectId) : null;
  const recipe = await recipeById(recipeId, { shots, projectId });
  if (!recipe) return NextResponse.json({ error: "No such recipe." }, { status: 404 });
  return NextResponse.json({ recipe, project: projectId });
});

export const PATCH = withTenant(async function PATCH(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { recipeId } = await params;
  const cur = await recipeById(recipeId);
  if (!cur) return NextResponse.json({ error: "No such recipe." }, { status: 404 });
  if (cur.scope === "platform") return NextResponse.json({ error: "The platform's recipes are read-only — copy one to change it." }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const stages: StagePatch[] = Array.isArray(b?.stages) ? b.stages.filter((s: unknown) => s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string").map((s: Record<string, unknown>): StagePatch => ({
    id: String(s.id),
    engine: typeof s.engine === "string" ? s.engine : undefined,
    mode: isStageMode(s.mode) ? s.mode : undefined,
    capCredits: s.capCredits === null ? null : typeof s.capCredits === "number" && s.capCredits >= 0 ? Math.round(s.capCredits) : undefined,
    units: typeof s.units === "number" && s.units > 0 ? s.units : undefined,
    perShot: s.perShot === null ? null : typeof s.perShot === "number" && s.perShot > 0 ? s.perShot : undefined,
    name: typeof s.name === "string" ? s.name : undefined,
  })).slice(0, 40) : [];
  const recipe = await updateRecipe(recipeId, { name: typeof b?.name === "string" ? b.name : undefined, blurb: typeof b?.blurb === "string" ? b.blurb : undefined, stages });
  if (!recipe) return NextResponse.json({ error: "That engine is not in the registry, or does not make what this step makes." }, { status: 400 });
  return NextResponse.json({ recipe });
});
