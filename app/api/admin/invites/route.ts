import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireSuperAdmin } from "@/lib/auth";
import { platformDb, platformReady, now, platformKeysByDefault, rowToWorkspace } from "@/lib/platform";
import { creditStateFor } from "@/lib/credits";
import { creditUsd, signupCredits } from "@/lib/creditTerms";
import { defaultAllowanceUsd } from "@/lib/allowance";
import { gatewayMintConfigured } from "@/lib/vercelKeys";
import { mailConfigured, sendMail, inviteOrigin } from "@/lib/mail";
import { provisioningConfigured } from "@/lib/provision";
import { keyringConfigured } from "@/lib/keyring";
import { meterByWorkspace, marginUsd } from "@/lib/meter";

export const dynamic = "force-dynamic";
const INVITE_DAYS = 14;

/**
 * Sign-up invitations: the platform owner's door. An invitation lets one
 * address create an account and a workspace of its own.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const p = platformDb();
  const [invites, requests, workspaces] = await Promise.all([
    p.execute({ sql: `SELECT * FROM signup_invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`, args: [now()] }),
    p.execute(`SELECT id, name, email, note, mailed, created_at FROM access_requests WHERE handled_at IS NULL ORDER BY created_at DESC LIMIT 100`),
    p.execute(`SELECT w.*, a.email AS owner_email, a.name AS owner_name,
                      (SELECT COUNT(*) FROM memberships m WHERE m.workspace_id = w.id AND m.disabled = 0) AS members
               FROM workspaces w LEFT JOIN accounts a ON a.id = w.owner_id ORDER BY w.created_at`),
  ]);
  const spend = await meterByWorkspace(now() - 30 * 86_400_000).catch(() => new Map());
  const credits = await Promise.all((workspaces.rows as any[]).map(async (r) => {
    try { return await creditStateFor(rowToWorkspace(r)); } catch { return null; }
  }));
  return NextResponse.json({
    creditUsd: creditUsd(),
    signupCredits: signupCredits(),
    ready: provisioningConfigured() && keyringConfigured(),
    mail: mailConfigured(),
    platformKeysByDefault: platformKeysByDefault(),
    defaultAllowanceUsd: defaultAllowanceUsd(),
    gatewayMint: gatewayMintConfigured(),
    invites: invites.rows.map((r: any) => ({ code: r.code, email: r.email, name: r.name, note: r.note, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), sentAt: r.sent_at == null ? null : Number(r.sent_at), sendCount: Number(r.send_count ?? 0) })),
    requests: requests.rows.map((r: any) => ({ id: r.id, name: r.name, email: r.email, note: r.note, mailed: Boolean(Number(r.mailed)), createdAt: Number(r.created_at) })),
    workspaces: workspaces.rows.map((r: any, i: number) => ({ id: r.id, slug: r.slug, name: r.name, legacy: Number(r.legacy) === 1, platformKeys: Number(r.uses_platform_keys) === 1, allowanceUsd: r.allowance_usd == null ? null : Number(r.allowance_usd), gatewayKey: Boolean(r.gateway_key_id), credits: credits[i] ? { granted: credits[i]!.granted, used: credits[i]!.used, balance: credits[i]!.balance } : null, createdAt: Number(r.created_at), owner: r.owner_email ? { email: r.owner_email, name: r.owner_name } : null, members: Number(r.members ?? 0),
      spend30: (() => { const m = spend.get(String(r.id)); return m ? { ...m, marginUsd: marginUsd(m.billedCredits, m.engineCostUsd, creditUsd()) } : null; })(),
      suspended: Boolean(r.suspended_at), suspendedReason: r.suspended_reason ?? null, flagged: Boolean(r.flagged_at), flagNote: r.flag_note ?? null, internalTest: Number(r.internal_test ?? 0) === 1,
      limits: { concurrency: r.concurrency == null ? null : Number(r.concurrency), rendersPerHour: r.renders_per_hour == null ? null : Number(r.renders_per_hour), storageGb: r.storage_quota_bytes == null ? null : Math.round(Number(r.storage_quota_bytes) / 1e9 * 10) / 10 } })),
  });
}

export async function POST(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  await platformReady();
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  const name = String(body.name ?? "").trim().slice(0, 80);
  const note = String(body.note ?? "").trim().slice(0, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
  const code = randomBytes(24).toString("base64url");
  const ts = now();
  const expiresAt = ts + INVITE_DAYS * 86400_000;
  const p = platformDb();
  await p.execute({
    sql: `INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
    args: [code, email, name, note, got.user.id, ts, expiresAt],
  });
  if (body.requestId) await p.execute({ sql: `UPDATE access_requests SET handled_at = ? WHERE id = ?`, args: [ts, String(body.requestId)] });
  const link = `${inviteOrigin(req)}/signup?invite=${code}`;
  let sent = false; let mailError: string | null = null;
  if (mailConfigured() && body.send !== false) {
    try {
      await sendMail({
        to: email, subject: `${got.user.name} invited you to particl studio`,
        text: `Hi ${name || "there"},\n\n${got.user.name} has invited you to particl studio — a room for making shots, and for knowing what they cost. Create your account and your own workspace here:\n${link}\n\nThe link is yours alone and works for ${INVITE_DAYS} days.\n\n— particl studio`,
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#15171C;line-height:1.5;background:#FCFCFD"><p style="font-size:17px;margin:0 0 12px">Hi ${name || "there"},</p><p style="font-size:15px;color:#666A72;margin:0 0 20px"><strong style="color:#15171C">${got.user.name}</strong> has invited you to particl studio — a room for making shots, and for knowing what they cost. Create your account and your own workspace:</p><p style="margin:0 0 22px"><a href="${link}" style="display:inline-block;background:#15171C;color:#F5F6F8;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">Create your workspace</a></p><p style="font-size:13.5px;color:#666A72;margin:0 0 18px">The link is yours alone and works for ${INVITE_DAYS} days.</p><p style="font-size:12px;color:#8A8E96;margin:0;word-break:break-all">If the button doesn't work: ${link}</p></div>`,
      });
      sent = true;
      await p.execute({ sql: `UPDATE signup_invites SET sent_at = ?, send_count = send_count + 1 WHERE code = ?`, args: [now(), code] });
    } catch (e) { mailError = (e as Error).message; }
  }
  return NextResponse.json({ code, link, email, name, expiresInDays: INVITE_DAYS, sent, mailError });
}
