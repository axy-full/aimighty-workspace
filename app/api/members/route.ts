import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { ownerMaskFor } from "@/lib/platformOwnerPrivacy";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Active teammates — names only, for @mention autocomplete. Any member. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const rs = await db().execute(
    `SELECT id, email, name FROM users WHERE disabled = 0 ORDER BY name`
  );
  // The platform owner is not a teammate to mention outside the house (lib/platformOwnerPrivacy.ts).
  const mask = await ownerMaskFor(requireTenant());
  return NextResponse.json({
    members: mask.members(rs.rows as any[]).map((r: any) => ({ id: r.id, name: r.name })),
  });
});
