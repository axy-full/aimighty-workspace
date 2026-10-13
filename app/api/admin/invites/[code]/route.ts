import {recoveryRoute} from '@/lib/recovery';
import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { platformDb, platformReady, now } from "@/lib/platform";
import { inviteRef, platformAuditStatement } from "@/lib/platformAudit";
import { mailConfigured, sendMail, inviteOrigin, signupInviteEmail, MAIL_LINK_UNSET } from "@/lib/mail";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/** Revoke: the link stops working. The change and its audit line commit together (lib/platformAudit.ts). */
export const DELETE = recoveryRoute(async function DELETE(_req: Request, { params }: Ctx) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const { code } = await params;
  await platformDb().batch([
    { sql: `DELETE FROM signup_invites WHERE code = ? AND used_at IS NULL`, args: [code] },
    platformAuditStatement({ actorId: got.user.id, action: "invite.revoked", targetType: "invite", targetId: inviteRef(code) }, true),
  ], "write");
  return NextResponse.json({ ok: true });
});

/**
 * Resend: the same link, emailed again, for an invitation still open (not used, not expired). Mail goes only to the
 * address the invitation was made for, and only from the configured origin (never the request's headers), as the first
 * send does (app/api/admin/invites/route.ts).
 */
export const POST = recoveryRoute(async function POST(req: Request, { params }: Ctx) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const { code } = await params;
  const rs = await platformDb().execute({ sql: `SELECT email, name FROM signup_invites WHERE code = ? AND used_at IS NULL AND expires_at > ?`, args: [code, now()] });
  const row = rs.rows[0] as { email?: unknown; name?: unknown } | undefined;
  if (!row) return NextResponse.json({ error: "That invitation is used, expired or revoked." }, { status: 404 });
  if (!mailConfigured()) return NextResponse.json({ error: "Email isn't set up, so copy the link and send it yourself." }, { status: 409 });
  const origin = inviteOrigin(req);
  if (origin === null) return NextResponse.json({ error: MAIL_LINK_UNSET }, { status: 409 });
  const link = `${origin}/signup?invite=${code}`;
  /* The attempt is on the record before anything is sent: if its line cannot be written, nothing is sent, so a send is never unrecorded. */
  const ref = inviteRef(code);
  try {
    await platformDb().batch([
      { sql: `UPDATE signup_invites SET send_count = send_count + 1 WHERE code = ?`, args: [code] },
      platformAuditStatement({ actorId: got.user.id, action: "invite.resent", targetType: "invite", targetId: ref, details: { sent: false } }, true),
    ], "write");
  } catch {
    return NextResponse.json({ error: "It could not be recorded, so nothing was sent. Try again." }, { status: 503 });
  }
  try {
    await sendMail({ to: String(row.email), ...signupInviteEmail({ name: String(row.name ?? ""), link, days: 14 }) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
  /* It went. Its own line says so; if that cannot be written the attempt line above still stands, and the answer is still the true one. */
  await platformDb().batch([
    { sql: `UPDATE signup_invites SET sent_at = ? WHERE code = ?`, args: [now(), code] },
    platformAuditStatement({ actorId: got.user.id, action: "invite.resent", targetType: "invite", targetId: ref, details: { sent: true } }, true),
  ], "write").catch((error: unknown) => { console.error(JSON.stringify({ level: "error", event: "platform_audit.write_failed", action: "invite.resent", message: error instanceof Error ? error.message : "unknown" })); });
  return NextResponse.json({ ok: true, sent: true });
});
