import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Revoke a token. Session-only, and only your own — revocation is instant
 *  because every request checks revoked_at. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Sign in to revoke a token" }, { status: 401 });
  await ready();
  const { id } = await params;
  await db().execute({
    sql: `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    args: [now(), id, user.id],
  });
  return NextResponse.json({ ok: true });
}
