import { NextResponse } from "next/server";
import { db, ready, now } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { mailConfigured, emailInvite } from "@/lib/mail";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ code: string }> };

/** Email an invitation again — the same link, the same expiry. */
export async function POST(req: Request, { params }: Ctx) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();
  if (!mailConfigured()) {
    return NextResponse.json({ error: "Email isn't set up on this deployment: add RESEND_API_KEY and MAIL_FROM in Vercel." }, { status: 400 });
  }
  const { code } = await params;
  const rs = await db().execute({
    sql: `SELECT code, email, name, role, expires_at, used_at FROM invites WHERE code=? LIMIT 1`, args: [code],
  });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const iv = rs.rows[0] as any;
  if (!iv || iv.used_at) return NextResponse.json({ error: "No such invitation." }, { status: 404 });
  if (Number(iv.expires_at) <= now()) {
    return NextResponse.json({ error: "That invitation has expired — create a new one." }, { status: 400 });
  }
  try {
    await emailInvite({
      code: iv.code, email: iv.email, name: iv.name, role: iv.role,
      expiresAt: Number(iv.expires_at), inviter: got.user.name, req,
    });
    return NextResponse.json({ ok: true, sent: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
