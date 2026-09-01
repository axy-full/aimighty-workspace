import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await ctx.params;
  await ready();
  await db().execute({ sql: `DELETE FROM shot_presets WHERE id = ?`, args: [id] });
  return NextResponse.json({ ok: true });
}
