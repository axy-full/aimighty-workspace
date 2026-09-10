import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { platformDb, platformReady, newId, now, SUPER_ADMIN_EMAIL } from "@/lib/platform";
import { reportInput } from "@/lib/reports";
import { sendMail, mailConfigured } from "@/lib/mail";
import { currentContext } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Anyone may report something; the desk reads every one.
 *
 * IT STAYS OPEN. Whoever needs this most is the person with no account —
 * somebody who found their own face in a render, or a stranger who came
 * across a page. Putting a sign-in in front of that would close it to the
 * people it exists for, so the answer to abuse of it is not a login.
 *
 * It was, though, an unauthenticated mail relay: every call sent one email
 * to the platform's own address, with no ceiling. A loop empties the desk's
 * inbox of anything real, which is the cheapest way to make a report system
 * useless — you do not have to suppress a report if you can bury it.
 *
 * So the writes are counted, by a salted hash of the caller's address and by
 * the email they gave, over a day. Past the ceiling the REPORT IS STILL
 * STORED and only the mail is dropped: losing a genuine report to a noisy
 * neighbour on the same address would be the same failure the flood was
 * trying to cause.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Enough for somebody reporting a page at a time; far short of a flood. */
const MAIL_PER_IP_PER_DAY = 10;
const MAIL_PER_EMAIL_PER_DAY = 10;
/** Above this, stop writing rows too: the table is the last thing to protect. */
const ROWS_PER_IP_PER_DAY = 200;

/** One-way and salted. This exists to count reports, not to identify anyone. */
function hashIp(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip") ?? "";
  if (!ip) return "";
  const salt = process.env.SESSION_SECRET ?? process.env.TURSO_AUTH_TOKEN ?? "particl";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const v = reportInput(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  await platformReady();
  const ctx = await currentContext().catch(() => null);
  const ipHash = hashIp(req);
  const since = now() - DAY;

  const count = async (sql: string, args: unknown[]): Promise<number> => {
    try {
      const rs = await platformDb().execute({ sql, args: args as never[] });
      return Number((rs.rows[0] as Record<string, unknown>)?.n ?? 0);
    } catch { return 0; }
  };
  const [fromIp, fromEmail] = await Promise.all([
    ipHash ? count(`SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?`, [ipHash, since]) : Promise.resolve(0),
    v.value.email ? count(`SELECT COUNT(*) AS n FROM reports WHERE email = ? AND created_at > ?`, [v.value.email, since]) : Promise.resolve(0),
  ]);

  /* The one refusal, and it is deliberately far out: somebody hammering this
     hard is not reporting anything. Below it every report is kept. */
  if (ipHash && fromIp >= ROWS_PER_IP_PER_DAY) {
    return NextResponse.json({ error: "That's already with us." }, { status: 429 });
  }

  const id = newId("rp");
  await platformDb().execute({
    sql: `INSERT INTO reports (id, ip_hash, url, reason, details, email, account_id, workspace_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [id, ipHash || null, v.value.url, v.value.reason, v.value.details, v.value.email, ctx?.user.id ?? null, ctx?.workspace?.id ?? null, now()],
  });

  /* Mail is the part that can be weaponised, so mail is the part that stops.
     The report is on the desk either way, and the desk lists them. */
  const quiet = fromIp >= MAIL_PER_IP_PER_DAY || fromEmail >= MAIL_PER_EMAIL_PER_DAY;
  if (!quiet && mailConfigured() && SUPER_ADMIN_EMAIL) {
    const text = `A report came in.\n\nWhere: ${v.value.url}\nWhat: ${v.value.reason}\n${v.value.details ? `Details: ${v.value.details}\n` : ""}${v.value.email ? `From: ${v.value.email}\n` : ""}\nRead it on the platform desk.`;
    await sendMail({ to: SUPER_ADMIN_EMAIL, subject: "Content reported", text, html: `<p>${text.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` }).catch(() => {});
  }

  /* The same answer either way. A reporter learning which of their reports
     mailed the desk is a reporter learning how to stay under the ceiling. */
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
