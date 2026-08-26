import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();
  const { code } = await params;
  await db().execute({ sql: `DELETE FROM invites WHERE code=?`, args: [code] });
  return NextResponse.json({ ok: true });
}
