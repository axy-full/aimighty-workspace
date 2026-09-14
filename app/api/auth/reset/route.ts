import {reserveRecoveryContinuation} from "@/lib/recovery";
import {recoveryRoute} from '@/lib/recovery';
import { NextResponse, after } from "next/server";
import { randomBytes } from "node:crypto";
import { findByEmail, sourceKey, tokenHash } from "@/lib/auth";
import { platformDb, platformReady, now } from "@/lib/platform";
import { mailConfigured, sendMail, resetEmail, inviteOrigin } from "@/lib/mail";
import { accountJson, accountFailure, sameOriginProblem } from "@/lib/accountDb";

export const dynamic = "force-dynamic";

const TTL_MS = 60 * 60 * 1000;
const PER_SOURCE = 6;
const PER_USER = 3;

/**
 * "Forgot password": mail a single-use link to the registered address. The
 * answer is the same whatever the address, and the email is sent after the
 * response, so neither the words nor the timing say which emails exist.
 */
export const POST = recoveryRoute(async function POST(req: Request) {
  if (sameOriginProblem(req)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  await platformReady();
  let body: Record<string, unknown>;
  try { body = await accountJson(req); } catch (error) { return accountFailure(error); }
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return NextResponse.json({ error: "Enter the email you signed up with." }, { status: 400 });
  if (!mailConfigured()) {
    return NextResponse.json({ error: "Email isn't set up on this deployment yet, so a reset can't be sent — contact management and they'll sort it." }, { status: 503 });
  }
  const generic = { ok: true, message: "If that address is registered, an email is on its way. The link works for an hour." };
  const p = platformDb();
  const source = sourceKey(req);
  const ts = now();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const recent = await p.execute({ sql: `SELECT COUNT(*) AS n FROM password_resets WHERE ip_hash = ? AND created_at > ?`, args: [source, ts - TTL_MS] });
  if (Number((recent.rows[0] as any)?.n ?? 0) >= PER_SOURCE) return NextResponse.json(generic);
  const user = await findByEmail(email);
  if (!user || Number(user.disabled)) return NextResponse.json(generic);
  const mine = await p.execute({ sql: `SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?`, args: [user.id, ts - TTL_MS] });
  if (Number((mine.rows[0] as any)?.n ?? 0) >= PER_USER) return NextResponse.json(generic);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = ts + TTL_MS;
  await p.execute({
    sql: `INSERT INTO password_resets (token_hash, user_id, ip_hash, created_at, expires_at) VALUES (?,?,?,?,?)`,
    args: [tokenHash(token), user.id, source, ts, expiresAt],
  });
  const origin = inviteOrigin(req);
  const mail = resetEmail({ name: String(user.name), link: `${origin}/reset/${token}`, expiresAt, origin });
  after(await reserveRecoveryContinuation('after-response', async () => {
    try { await sendMail({ to: email, ...mail }); }
    catch (e) { console.error("[reset] email not sent:", (e as Error).message); }
  }));
  return NextResponse.json(generic);
});
