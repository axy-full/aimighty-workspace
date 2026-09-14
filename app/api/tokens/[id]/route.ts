import { securityAuditStatement } from "@/lib/securityAudit";
import { requireTenant } from "@/lib/tenant";
import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireSession, withTenant } from "@/lib/auth";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** Revoke a token. Session-only, and only your own — revocation is instant
 *  because every request checks revoked_at.
 *
 *  "Session-only" was the intent and `currentUser()` was not it: that answers
 *  for a bearer caller too, so a leaked token could revoke its siblings —
 *  cutting off the CLI and the MCP client while keeping itself, which is how
 *  somebody hides. `requireSession()` refuses a token caller outright. */
export const DELETE = withTenant(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireSession();
  if (got.response) return got.response;
  const user = got.user;
  await ready();
  const { id } = await params;
  if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(id))return NextResponse.json({error:"Invalid token."},{status:400});
  await db().batch([{
    sql: `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    args: [now(), id, user.id],
  }, securityAuditStatement({workspaceId:requireTenant().id,actorId:user.id,action:"api_token.revoked",targetType:"api_token",targetId:id}, true)], "write");
  return NextResponse.json({ ok: true });
}, { requireRequestScope: true });
