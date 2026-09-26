import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady } from "@/lib/platform";
import { mailConfigured, sendMail, inviteEmail, inviteOrigin } from "@/lib/mail";
import { accountFailure, AccountError } from "@/lib/accountDb";
import { mailWorkspaceInvite } from "@/lib/teamInvitations";

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
  try {
    const origin = inviteOrigin(req);
    // The seat, the per-invitation cap and the mail limits come first; a failed send gives its slot back.
    await mailWorkspaceInvite({ ws, code, origin, checkSeat: true, deliver: (to, link) => sendMail({ to, ...inviteEmail({ name: String(iv.name), inviter: `${got.user.name} (${ws.name})`, link, role: String(iv.role), expiresAt: Number(iv.expires_at), origin }) }) });
    return NextResponse.json({ ok: true, sent: true });
  } catch (e) {
    if (e instanceof AccountError) return accountFailure(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}, { requireRequestScope: true });
