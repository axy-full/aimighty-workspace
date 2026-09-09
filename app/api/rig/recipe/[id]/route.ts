import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { recipeOf } from "@/lib/runs";

/**
 * A production's recipe as a graph (brief 3, surface 1d).
 *
 * The id is the production's. A recipe with no run yet answers with every
 * stage queued, which is what it is.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  return NextResponse.json({ recipe: await recipeOf(id) });
});
