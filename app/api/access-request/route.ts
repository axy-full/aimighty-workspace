import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { platformDb as db, platformReady as ready, now, newId } from "@/lib/platform";
import { SUPER_ADMIN_EMAIL } from "@/lib/auth";
import { mailConfigured, sendMail } from "@/lib/mail";

export const dynamic = "force-dynamic";

/**
 * Somebody asking to be let in.
 *
 * The tool is invitation-only and the interface is public, so strangers
 * need a way to ask — and the whole point of this route is that they get
 * one WITHOUT ever being shown who they are asking. A mailto: would put
 * the administrator's address in every visitor's page source, which is the
 * thing this replaces. The address is read here, on the server, and the
 * reply-to is set to the requester so answering is one click.
 *
 * It is unauthenticated by necessity — the people who need it have no
 * account — and it sends email, which is a spam relay unless it is held
 * down. Three limits, cheapest first: a honeypot field no human sees, a
 * cap per address, and a cap per hashed IP. The request is stored either
 * way, so a failed send never loses somebody's ask.
 */

const PER_IP_PER_DAY = 5;
const PER_EMAIL_PER_DAY = 2;
const DAY = 24 * 60 * 60 * 1000;

/** One-way and salted. This exists to count requests, not to identify anyone. */
function hashIp(req: NextRequest): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip") ?? "";
  if (!ip) return "";
  const salt = process.env.SESSION_SECRET ?? process.env.TURSO_AUTH_TOKEN ?? "particl";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

const looksLikeEmail = (s: string) =>
  /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(s) && s.length <= 200;

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));

  /* The honeypot. A field positioned off-screen and never focusable, so
     anything that fills it is not a person. Answered with the same 200 a
     real request gets: a bot that is told it failed simply tries again. */
  if (typeof b.company === "string" && b.company.trim()) {
    return NextResponse.json({ ok: true });
  }

  const email = String(b.email ?? "").trim().toLowerCase();
  const name = String(b.name ?? "").trim().slice(0, 120);
  const note = String(b.note ?? "").trim().slice(0, 1200);
  if (!looksLikeEmail(email)) {
    return NextResponse.json(
      { error: "That doesn't look like an email address." }, { status: 400 },
    );
  }

  await ready();
  const since = now() - DAY;
  const ipHash = hashIp(req);

  const [byEmail, byIp] = await Promise.all([
    db().execute({
      sql: `SELECT COUNT(*) AS n FROM access_requests WHERE email = ? AND created_at > ?`,
      args: [email, since],
    }),
    ipHash
      ? db().execute({
        sql: `SELECT COUNT(*) AS n FROM access_requests WHERE ip_hash = ? AND created_at > ?`,
        args: [ipHash, since],
      })
      : Promise.resolve({ rows: [{ n: 0 }] }),
  ]);
  const n = (r: { rows: unknown[] }) => Number((r.rows[0] as Record<string, unknown>)?.n ?? 0);

  if (n(byEmail) >= PER_EMAIL_PER_DAY || n(byIp) >= PER_IP_PER_DAY) {
    /* Deliberately warm rather than accusatory: the overwhelmingly likely
       reader is somebody who pressed the button twice. */
    return NextResponse.json(
      { error: "That's already with us — you'll hear back by email." },
      { status: 429 },
    );
  }

  const rowId = newId("req");
  await db().execute({
    sql: `INSERT INTO access_requests (id, name, email, note, ip_hash, mailed, created_at)
          VALUES (?,?,?,?,?,0,?)`,
    args: [rowId, name, email, note, ipHash, now()],
  });

  /* The send is best-effort. The row above is the record that matters, and
     an admin who cannot receive mail can still read the requests. */
  let mailed = false;
  if (mailConfigured()) {
    try {
      const who = name ? `${name} <${email}>` : email;
      await sendMail({
        to: SUPER_ADMIN_EMAIL,
        replyTo: email,
        subject: `Particl — invitation request from ${name || email}`,
        text: [
          `${who} asked for an invitation to Particl.`,
          note ? `\nThey said:\n${note}` : "",
          `\nReply to this email to answer them directly.`,
          `Invite them from the Team page.`,
        ].filter(Boolean).join("\n"),
        html: [
          `<p><strong>${escapeHtml(who)}</strong> asked for an invitation to Particl.</p>`,
          note ? `<p>They said:</p><blockquote>${escapeHtml(note)}</blockquote>` : "",
          `<p>Reply to this email to answer them directly, or invite them from the Team page.</p>`,
        ].filter(Boolean).join("\n"),
      });
      mailed = true;
      await db().execute({
        sql: `UPDATE access_requests SET mailed = 1 WHERE id = ?`, args: [rowId],
      });
    } catch (e) {
      console.error("access request: mail failed:", (e as Error).message);
    }
  }

  return NextResponse.json({ ok: true, mailed });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
