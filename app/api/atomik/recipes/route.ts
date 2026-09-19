import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { connectedRecipes } from "@/lib/higgsfield-consumer/recipes-service";

export const dynamic = "force-dynamic";

/**
 * The recipes the workspace owner's connected account offers (A5 + A6), for
 * the composer's `/` menu and the Recipes page. Names and short descriptions
 * only; a recipe's text is read when it is run. Empty for anyone else.
 */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  return NextResponse.json({ recipes: await connectedRecipes(got.user, got.token) }, { headers: { "Cache-Control": "private, no-store" } });
});
