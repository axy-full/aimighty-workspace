import { NextResponse } from "next/server";
import { mailConfigured, mailFrom, emailInvite } from "@/lib/mail";
import { isSuperAdmin } from "@/lib/auth";
import { randomBytes } from "node:crypto";
import { db, ready, now } from "@/lib/db";
import { requireAdmin, findByEmail } from "@/lib/auth";

export const dynamic = "force-dynamic";
const INVITE_DAYS = 7;
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET() {
  const got = await requireAdmin();
  if (got.response) return got.response;
  await ready();
  const canSeeRoles = isSuperAdmin(got.user.email);

  const [users, invites] = await Promise.all([
    db().execute(`
      SELECT u.id, u.email, u.name, u.role, u.disabled, u.last_seen, u.created_at, u.locked_until,
             (SELECT COUNT(*) FROM generations g WHERE g.created_by = u.id) AS clips,
             (SELECT COALESCE(SUM(COALESCE(g.cost_usd,0)+COALESCE(g.refine_cost_usd,0)),0)
                FROM generations g WHERE g.created_by = u.id) AS spend
      FROM users u WHERE u.deleted_at IS NULL ORDER BY u.created_at ASC`),
    db().execute({
      sql: `SELECT code, email, name, role, created_at, expires_at, sent_at, send_count FROM invites
            WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      args: [now()],
    }),
  ]);

  return NextResponse.json({
    mail: { configured: mailConfigured(), from: mailFrom() },
    /* Standing in the workspace is between a person and the owner. Everyone
       else on the roster — members and admins alike — sees who is here and
       what they have made, and not who outranks whom. Withheld on the SERVER
       rather than hidden in the page, or it would still be one devtools panel
       away from being read. */
    canSeeRoles,
    users: users.rows.map((r: any) => ({
      id: r.id, email: r.email, name: r.name,
      ...(canSeeRoles ? { role: r.role, permanent: isSuperAdmin(r.email) } : {}),
      disabled: Boolean(Number(r.disabled)),
      locked: r.locked_until != null && Number(r.locked_until) > now(),
      lastSeen: r.last_seen == null ? null : Number(r.last_seen),
      createdAt: Number(r.created_at),
      clips: Number(r.clips), spend: Number(r.spend),
    })),
    invites: invites.rows.map((r: any) => ({
      code: r.code, email: r.email, name: r.name,
      ...(canSeeRoles ? { role: r.role } : {}),
      createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
      sentAt: r.sent_at == null ? null : Number(r.sent_at), sendCount: Number(r.send_count ?? 0),
    })),
  });
}

/** Creates an invite. No email is sent — the admin copies the link and shares it. */
export async function POST(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  // Same reasoning as the roster: only the owner decides standing, so an
  // invite from anyone else is a member invite whatever it asked for.
  const mayChooseRole = isSuperAdmin(got.user.email);
  await ready();

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  const role = mayChooseRole && body.role === "admin" ? "admin" : "member";

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
  }
  if (await findByEmail(email)) {
    return NextResponse.json({ error: "That person already has an account" }, { status: 409 });
  }

  const code = randomBytes(24).toString("base64url");
  const ts = now();
  const expiresAt = ts + INVITE_DAYS * 86400_000;
  await db().execute({
    sql: `INSERT INTO invites (code,email,name,role,created_by,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [code, email, name.slice(0, 80), role, got.user.id, ts, expiresAt],
  });

  // When mail is set up the link goes out at once. A failed send is reported
  // and the invite stands — the admin can still copy the link.
  let sent = false;
  let mailError: string | null = null;
  if (mailConfigured() && body.send !== false) {
    try {
      await emailInvite({ code, email, name, role, expiresAt, inviter: got.user.name, req });
      sent = true;
    } catch (e) {
      mailError = (e as Error).message;
    }
  }

  return NextResponse.json({ code, email, name, role, expiresInDays: INVITE_DAYS, sent, mailError });
}
