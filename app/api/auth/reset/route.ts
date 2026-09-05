import { NextResponse, after } from "next/server";
import { randomBytes } from "node:crypto";
import { db, ready, now } from "@/lib/db";
import { findByEmail, sourceKey, tokenHash } from "@/lib/auth";
import { mailConfigured, sendMail, resetEmail, inviteOrigin } from "@/lib/mail";

export const dynamic = "force-dynamic";

const TTL_MS = 60 * 60 * 1000;
/** Requests one place may make in an hour, and one account may receive. */
const PER_SOURCE = 6;
const PER_USER = 3;

/**
 * "Forgot password": mail a single-use link to the registered address.
 *
 * The answer is the same whatever the address — registered, unknown,
 * disabled, throttled — so this page cannot be used to find out which
 * emails have accounts. The email itself is sent AFTER the response, so
 * the time the request takes doesn't answer that question either.
 */
export async function POST(req: Request) {
  await ready();
  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return NextResponse.json({ error: "Enter the email you signed up with." }, { status: 400 });
  if (!mailConfigured()) {
    return NextResponse.json({ error: "Email isn't set up on this deployment yet, so a reset can't be sent — contact management and they'll sort it." }, { status: 503 });
  }
  const generic = { ok: true, message: "If that address is registered, an email is on its way. The link works for an hour." };

  const source = sourceKey(req);
  const ts = now();
  const recent = await db().execute({
    sql: `SELECT COUNT(*) AS n FROM password_resets WHERE ip_hash = ? AND created_at > ?`,
    args: [source, ts - TTL_MS],
  });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  if (Number((recent.rows[0] as any)?.n ?? 0) >= PER_SOURCE) return NextResponse.json(generic);

  const user = await findByEmail(email);
  if (!user || Number(user.disabled)) return NextResponse.json(generic);

  const mine = await db().execute({
    sql: `SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?`,
    args: [user.id, ts - TTL_MS],
  });
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  if (Number((mine.rows[0] as any)?.n ?? 0) >= PER_USER) return NextResponse.json(generic);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = ts + TTL_MS;
  await db().execute({
    sql: `INSERT INTO password_resets (token_hash, user_id, ip_hash, created_at, expires_at) VALUES (?,?,?,?,?)`,
    args: [tokenHash(token), user.id, source, ts, expiresAt],
  });
  const origin = inviteOrigin(req);
  const link = `${origin}/reset/${token}`;
  const mail = resetEmail({ name: String(user.name), link, expiresAt, origin });
  after(async () => {
    try { await sendMail({ to: email, ...mail }); }
    catch (e) { console.error("[reset] email not sent:", (e as Error).message); }
  });
  return NextResponse.json(generic);
}
