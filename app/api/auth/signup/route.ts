import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, createSession, passwordProblem, hashPassword } from "@/lib/auth";
import { platformDb, platformReady, findAccountByEmail, createAccount, createWorkspace, welcomeGrant, now } from "@/lib/platform";
import { provisioningConfigured } from "@/lib/provision";
import { keyringConfigured } from "@/lib/keyring";
import { policyAccepted } from "@/lib/policyAccept";

export const dynamic = "force-dynamic";

/**
 * Sign up, by invitation: an account and a workspace of its own.
 *
 * The invitation names the address it was sent to and that is the address
 * the account gets. The workspace is provisioned its own database before
 * the invitation is spent, so a failed provision leaves the invitation
 * usable and nothing half-made.
 */
export async function POST(req: Request) {
  await platformReady();
  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? "").trim();
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const workspace = String(body.workspace ?? "").trim();
  const password = String(body.password ?? "");
  if (!code) return NextResponse.json({ error: "Sign-up is by invitation." }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!workspace) return NextResponse.json({ error: "Name your workspace — your studio, your company, or you." }, { status: 400 });
  if (!policyAccepted(body)) return NextResponse.json({ error: "Read the content policy and the terms, and tick the box." }, { status: 400 });
  const pw = passwordProblem(password);
  if (pw) return NextResponse.json({ error: pw }, { status: 400 });
  if (!provisioningConfigured() || !keyringConfigured()) {
    return NextResponse.json({ error: "Sign-up isn't open on this deployment yet — contact management." }, { status: 503 });
  }

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const inv = (await platformDb().execute({ sql: `SELECT * FROM signup_invites WHERE code = ? LIMIT 1`, args: [code] })).rows[0] as any;
  if (!inv) return NextResponse.json({ error: "That invitation isn't valid." }, { status: 404 });
  if (inv.used_at) return NextResponse.json({ error: "That invitation has already been used." }, { status: 409 });
  if (Number(inv.expires_at) < now()) return NextResponse.json({ error: "That invitation has expired. Ask for a new one." }, { status: 410 });
  if (String(inv.email).toLowerCase() !== email) {
    return NextResponse.json({ error: "Sign up with the address the invitation was sent to." }, { status: 400 });
  }
  if (await findAccountByEmail(email)) {
    return NextResponse.json({ error: "An account already exists for that address — sign in instead." }, { status: 409 });
  }

  const account = await createAccount(email, name, hashPassword(password));
  let ws;
  try {
    ws = await createWorkspace({ name: workspace, owner: account });
  } catch (e) {
    // No workspace, no account: the invitation stays usable.
    await platformDb().execute({ sql: `DELETE FROM accounts WHERE id = ?`, args: [account.id] });
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
  await platformDb().execute({ sql: `UPDATE signup_invites SET used_at = ? WHERE code = ?`, args: [now(), code] });
  await platformDb().execute({ sql: `UPDATE accounts SET accepted_policy_at = ? WHERE id = ?`, args: [now(), account.id] });
  const token = await createSession(account.id, ws.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86400,
  });
  return NextResponse.json({ ok: true, workspace: { id: ws.id, name: ws.name, slug: ws.slug } });
}

/**
 * Is this invitation still good? The page asks before showing the form, and
 * reads `grant` — the welcome credits a new workspace receives — so the
 * STUDIO card's "and N credits" line never carries a literal number.
 */
export async function GET(req: Request) {
  await platformReady();
  const code = new URL(req.url).searchParams.get("code") ?? "";
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const inv = (await platformDb().execute({ sql: `SELECT email, name, used_at, expires_at FROM signup_invites WHERE code = ? LIMIT 1`, args: [code] })).rows[0] as any;
  if (!inv) return NextResponse.json({ error: "That invitation isn't valid." }, { status: 404 });
  if (inv.used_at) return NextResponse.json({ error: "That invitation has already been used." }, { status: 409 });
  if (Number(inv.expires_at) < now()) return NextResponse.json({ error: "That invitation has expired." }, { status: 410 });
  return NextResponse.json({ ok: true, email: inv.email, name: inv.name, open: provisioningConfigured() && keyringConfigured(), grant: await welcomeGrant() });
}
