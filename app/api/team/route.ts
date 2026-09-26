import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { mailConfigured, mailFrom, sendMail, inviteEmail, inviteOrigin } from "@/lib/mail";
import { db, ready, now } from "@/lib/db";
import { requireAdmin, withTenant, isPlatformOwner } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { platformDb, platformReady } from "@/lib/platform";
import { creditsApply } from "@/lib/credits";
import { accountFailure, AccountError } from "@/lib/accountDb";
import { createWorkspaceInvite, mailWorkspaceInvite } from "@/lib/teamInvitations";

export const dynamic = "force-dynamic";
const INVITE_DAYS = 7;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The workspace's roster: its memberships from the platform, with what
 * each person has made here from this workspace's own database. Standing
 * (owner · admin · member) is between a person and the owner: everyone
 * else sees who is here and what they made.
 */
export const GET = withTenant(async function GET() {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  const inCredits = creditsApply(ws);
  await Promise.all([ready(), platformReady()]);
  const canSeeRoles = got.user.owner || (await isPlatformOwner(got.user));

  const [members, invites, stats] = await Promise.all([
    platformDb().execute({
      sql: `SELECT a.id, a.email, a.name, a.last_seen, a.created_at, a.locked_until, a.disabled AS a_disabled,
                   m.role, m.disabled AS m_disabled, m.created_at AS joined_at
            FROM memberships m JOIN accounts a ON a.id = m.account_id
            WHERE m.workspace_id = ? AND a.deleted_at IS NULL ORDER BY m.created_at ASC`,
      args: [ws.id],
    }),
    platformDb().execute({
      sql: `SELECT code, email, name, role, created_at, expires_at, sent_at, send_count FROM workspace_invites
            WHERE workspace_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      args: [ws.id, now()],
    }),
    db().execute(`SELECT created_by AS id, COUNT(*) AS clips${inCredits ? "" : ", COALESCE(SUM(COALESCE(cost_usd,0)+COALESCE(refine_cost_usd,0)),0) AS spend"}
                  FROM generations GROUP BY created_by`),
  ]);
  const made = new Map((stats.rows as any[]).map((r) => [String(r.id), { clips: Number(r.clips), spend: Number(r.spend) }]));

  return NextResponse.json({
    mail: { configured: mailConfigured(), from: mailFrom() },
    workspace: { id: ws.id, name: ws.name, slug: ws.slug },
    requests: [],
    canSeeRoles,
    users: (members.rows as any[]).filter((r) => Number(r.m_disabled) === 0 || canSeeRoles).map((r) => ({
      id: r.id, email: r.email, name: r.name,
      ...(canSeeRoles ? { role: r.role === "owner" ? "admin" : r.role, standing: r.role, permanent: r.role === "owner" } : {}),
      disabled: Number(r.m_disabled) === 1 || Number(r.a_disabled) === 1,
      locked: r.locked_until != null && Number(r.locked_until) > now(),
      lastSeen: r.last_seen == null ? null : Number(r.last_seen),
      createdAt: Number(r.joined_at ?? r.created_at),
      clips: made.get(String(r.id))?.clips ?? 0,
      ...(!inCredits ? { spend: made.get(String(r.id))?.spend ?? 0 } : {}),
    })),
    invites: (invites.rows as any[]).map((r) => ({
      code: r.code, email: r.email, name: r.name,
      ...(canSeeRoles ? { role: r.role } : {}),
      createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
      sentAt: r.sent_at == null ? null : Number(r.sent_at), sendCount: Number(r.send_count ?? 0),
    })),
  }, { headers: { "Cache-Control": "no-store" } });
});

/** Invite someone onto this workspace. Standing is the owner's to choose. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireAdmin();
  if (got.response) return got.response;
  const ws = requireTenant();
  await platformReady();
  const mayChooseRole = got.user.owner || (await isPlatformOwner(got.user));
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim();
  const role = mayChooseRole && body.role === "admin" ? "admin" : "member";
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
  const already = await platformDb().execute({
    sql: `SELECT 1 FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.workspace_id = ? AND a.email = ? AND m.disabled = 0`,
    args: [ws.id, email],
  });
  if (already.rows.length) return NextResponse.json({ error: "That person is already on this workspace" }, { status: 409 });

  const code = randomBytes(24).toString("base64url");
  const expiresAt = now() + INVITE_DAYS * 86400_000;
  const mailing = mailConfigured() && body.send !== false;
  // Refused before anything is written when the plan has no seat left for it.
  try { await createWorkspaceInvite({ ws, code, email, name, role, createdBy: got.user.id, expiresAt }); }
  catch (error) { return accountFailure(error); }
  let sent = false; let mailError: string | null = null; let mailLimited = false;
  if (mailing) {
    try {
      const origin = inviteOrigin(req);
      await mailWorkspaceInvite({ ws, code, origin, deliver: (to, link) => sendMail({ to, ...inviteEmail({ name, inviter: `${got.user.name} (${ws.name})`, link, role, expiresAt, origin }) }) });
      sent = true;
    } catch (e) {
      mailError = (e as Error).message;
      // A mail limit is not a delivery failure: its words go to the admin as they are.
      mailLimited = e instanceof AccountError && e.status === 429;
    }
  }
  return NextResponse.json({ code, email, name, role, expiresInDays: INVITE_DAYS, sent, mailError, mailLimited });
}, { requireRequestScope: true });
