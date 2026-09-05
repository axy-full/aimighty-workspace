import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser, withTenant } from "@/lib/auth";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Active teammates — names only, for @mention autocomplete. Any member. */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const rs = await db().execute(
    `SELECT id, name FROM users WHERE disabled = 0 ORDER BY name`
  );
  return NextResponse.json({
    members: rs.rows.map((r: any) => ({ id: r.id, name: r.name })),
  });
});
