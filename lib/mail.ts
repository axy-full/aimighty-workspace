/**
 * Outbound mail — one job, invitations — through Resend's HTTP API.
 *
 * Two environment variables and nothing else:
 *   RESEND_API_KEY  the key from resend.com
 *   MAIL_FROM       the sender, e.g. "Particl <invites@particlstudio.com>";
 *                   the domain must be verified in Resend (three DNS records)
 *
 * Without them the app behaves as before: an invite is a link the admin
 * copies and shares. With them the link is also emailed, and the Team page
 * says so. A failed send never loses the invite — the link still exists.
 */

import { db, now } from "./db";

/** Overridable so a local stand-in can catch the request during rehearsal. */
const RESEND_URL = () =>
  `${process.env.RESEND_BASE_URL?.replace(/\/$/, "") ?? "https://api.resend.com"}/emails`;

export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

export function mailFrom(): string | null {
  return process.env.MAIL_FROM ?? null;
}

export async function sendMail(msg: {
  to: string; subject: string; text: string; html: string; replyTo?: string;
}): Promise<{ id: string }> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) throw new Error("Email isn't set up: RESEND_API_KEY and MAIL_FROM are needed.");
  const res = await fetch(RESEND_URL(), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 300);
    try { detail = JSON.parse(raw)?.message ?? detail; } catch { /* raw */ }
    throw new Error(`Email not sent (${res.status}): ${detail}`);
  }
  const j = JSON.parse(raw) as { id?: string };
  return { id: j.id ?? "" };
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The invitation, in plain words: who, what, the link, and when it expires. */
export function inviteEmail(opts: {
  name: string; inviter: string; link: string; role: string; expiresAt: number;
}): { subject: string; text: string; html: string } {
  const until = new Date(opts.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const roleLine = opts.role === "admin"
    ? "You're joining as an admin, so you can manage the team and the ledger as well as render."
    : "You're joining as a member: you can generate, edit and review shots.";
  const subject = `${opts.inviter} invited you to Particl`;
  const text =
`Hi ${opts.name},

${opts.inviter} has invited you to Particl, the studio's room for making shots.

Accept the invitation here:
${opts.link}

${roleLine}
The link is yours alone and works until ${until}.

— Particl`;
  const html =
`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1d1d1f;line-height:1.5">
  <p style="font-size:15px;font-weight:600;margin:0 0 20px">Particl</p>
  <p style="font-size:17px;margin:0 0 12px">Hi ${esc(opts.name)},</p>
  <p style="font-size:15px;color:#3a3a3c;margin:0 0 20px"><strong>${esc(opts.inviter)}</strong> has invited you to Particl, the studio's room for making shots.</p>
  <p style="margin:0 0 22px"><a href="${esc(opts.link)}" style="display:inline-block;background:#007aff;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">Accept the invitation</a></p>
  <p style="font-size:13.5px;color:#6e6e73;margin:0 0 6px">${esc(roleLine)}</p>
  <p style="font-size:13.5px;color:#6e6e73;margin:0 0 18px">The link is yours alone and works until ${esc(until)}.</p>
  <p style="font-size:12px;color:#a1a1a6;margin:0;word-break:break-all">If the button doesn't work: ${esc(opts.link)}</p>
</div>`;
  return { subject, text, html };
}

/** The public origin invitations should point at: the request's own host. */
export function inviteOrigin(req: Request): string {
  const forced = process.env.APP_ORIGIN?.replace(/\/$/, "");
  if (forced) return forced;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Send (or re-send) one invitation, and remember that it went. */
export async function emailInvite(opts: {
  code: string; email: string; name: string; role: string; expiresAt: number; inviter: string; req: Request;
}): Promise<void> {
  const link = `${inviteOrigin(opts.req)}/invite/${opts.code}`;
  const mail = inviteEmail({ name: opts.name, inviter: opts.inviter, link, role: opts.role, expiresAt: opts.expiresAt });
  await sendMail({ to: opts.email, ...mail });
  await db().execute({
    sql: `UPDATE invites SET sent_at=?, send_count=COALESCE(send_count,0)+1 WHERE code=?`,
    args: [now(), opts.code],
  });
}
