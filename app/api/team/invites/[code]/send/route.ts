import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady, now } from "@/lib/platform";
import { mailConfigured, sendMail, inviteEmail, inviteOrigin } from "@/lib/mail";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/** Email an invitation again — the same link, the same expiry. */
export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  if (!mailConfigured()) return NextResponse.json({ error: "Email isn't set up on this deployment." }, { status: 400 });
  const { code } = await params;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const iv = (await platformDb().execute({ sql: `SELECT * FROM workspace_invites WHERE code = ? AND workspace_id = ? LIMIT 1`, args: [code, ws.id] })).rows[0] as any;
  if (!iv || iv.used_at) return NextResponse.json({ error: "No such invitation." }, { status: 404 });
  if (Number(iv.expires_at) <= now()) return NextResponse.json({ error: "That invitation has expired — create a new one." }, { status: 400 });
  try {
    const origin = inviteOrigin(req);
    await sendMail({ to: String(iv.email), ...inviteEmail({ name: String(iv.name), inviter: `${got.user.name} (${ws.name})`, link: `${origin}/invite/${code}`, role: String(iv.role), expiresAt: Number(iv.expires_at), origin }) });
    await platformDb().execute({ sql: `UPDATE workspace_invites SET sent_at = ?, send_count = send_count + 1 WHERE code = ?`, args: [now(), code] });
    return NextResponse.json({ ok: true, sent: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
});
