import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { listRecipes, ensurePlatformRecipes, shotCount, projectExists } from "@/lib/runs";

/**
 * Every recipe the workspace can run (SOW surfaces 12d): the platform's
 * two, seeded on first read for a workspace made before they existed, then
 * the workspace's own — each with its steps, its whole-run price and how
 * many places it stops to ask. Beside `/api/rig/recipe/[projectId]`, which
 * keeps answering with one project's recipe.
 */
export const dynamic = "force-dynamic";

export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  await ensurePlatformRecipes(got.user.id).catch(() => 0);
  /* `?project=` prices every per-shot stage for that project's shots, so the cards and the pane say one number. */
  const wanted = new URL(req.url).searchParams.get("project");
  const projectId = wanted && (await projectExists(wanted)) ? wanted : null;
  const shots = projectId ? await shotCount(projectId) : null;
  /* The answer names the project it priced for, so a page never shows one project's numbers under another's name. */
  return NextResponse.json({ recipes: await listRecipes(shots), shots, project: projectId });
});
