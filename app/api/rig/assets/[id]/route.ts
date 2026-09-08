import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { assetGraphOf } from "@/lib/assetGraph";

/**
 * How a production's elements connect to its shots (brief 3, surface 2a).
 * The id is the production's.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  return NextResponse.json({ graph: await assetGraphOf(id) });
});
