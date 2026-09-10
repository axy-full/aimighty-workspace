import { NextResponse } from "next/server";
import { ceilingFor, wouldExceed, ceilingMessage } from "@/lib/planLimits";
import { cookies } from "next/headers";
import { SESSION_COOKIE, createSession, passwordProblem, hashPassword, currentContext } from "@/lib/auth";
import { platformDb, platformReady, findAccountByEmail, createAccount, getWorkspace, addMember, now, planOf, memberCount } from "@/lib/platform";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function lookup(code: string) {
  const inv = (await platformDb().execute({ sql: `SELECT * FROM workspace_invites WHERE code = ? LIMIT 1`, args: [code] })).rows[0] as any;
  if (!inv) return { problem: "That invite link isn't valid.", status: 404 } as const;
  if (inv.used_at) return { problem: "That invite has already been used.", status: 409 } as const;
  if (Number(inv.expires_at) < now()) return { problem: "That invite has expired. Ask for a new one.", status: 410 } as const;
  const ws = await getWorkspace(String(inv.workspace_id));
  if (!ws) return { problem: "That workspace no longer exists.", status: 410 } as const;
  return { inv, ws } as const;
}

/** What the invite is for, and whether the address already has an account. */
export async function GET(req: Request) {
  await platformReady();
  const code = new URL(req.url).searchParams.get("code") ?? "";
  const got = await lookup(code);
  if ("problem" in got) return NextResponse.json({ error: got.problem }, { status: got.status });
  const existing = await findAccountByEmail(String(got.inv.email));
  const ctx = await currentContext();
  return NextResponse.json({
    ok: true, workspace: got.ws.name, email: got.inv.email, name: got.inv.name, role: got.inv.role,
    hasAccount: Boolean(existing),
    signedInAsInvitee: Boolean(ctx && ctx.user.email.toLowerCase() === String(got.inv.email).toLowerCase()),
  });
}

/**
 * Join the workspace. A new person chooses a password and gets an account;
 * someone who already has one joins while signed in as that account.
 */
export async function POST(req: Request) {
  await platformReady();
  const body = await req.json().catch(() => ({}));
  const code = String(body.code ?? "").trim();
  const got = await lookup(code);
  if ("problem" in got) return NextResponse.json({ error: got.problem }, { status: got.status });
  const email = String(got.inv.email).toLowerCase();

  /* Invite is three members (§7A). Checked BEFORE an account is created, so
     somebody turned away is not left holding a half-made account with no
     workspace to open — and before the invite is marked used, so the code
     still works once there is room.
     A workspace on no plan has no ceiling, which is every workspace today.
     Already-over is only stopped from adding: nothing here removes anybody,
     because shrinking a plan should never quietly evict a colleague. */
  const plan = await planOf(got.ws).catch(() => null);
  const seats = ceilingFor(plan, "members");
  if (seats != null && wouldExceed(await memberCount(got.ws.id), seats)) {
    return NextResponse.json({ error: ceilingMessage(plan!, "members", seats) }, { status: 402 });
  }

  const existing = await findAccountByEmail(email);

  let accountId: string;
  if (existing) {
    const ctx = await currentContext();
    if (!ctx || ctx.user.email.toLowerCase() !== email) {
      return NextResponse.json({ error: "That address already has an account — sign in as it, then open this link again.", needsSignIn: true }, { status: 409 });
    }
    accountId = String(existing.id);
    await addMember(got.ws, { id: accountId, email, name: String(existing.name) }, got.inv.role === "admin" ? "admin" : "member");
  } else {
    const password = String(body.password ?? "");
    const pw = passwordProblem(password);
    if (pw) return NextResponse.json({ error: pw }, { status: 400 });
    const account = await createAccount(email, String(got.inv.name || body.name || email.split("@")[0]), hashPassword(password));
    accountId = account.id;
    await addMember(got.ws, account, got.inv.role === "admin" ? "admin" : "member");
  }
  await platformDb().execute({ sql: `UPDATE workspace_invites SET used_at = ? WHERE code = ?`, args: [now(), code] });
  const token = await createSession(accountId, got.ws.id);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86400,
  });
  return NextResponse.json({ ok: true, workspace: { id: got.ws.id, name: got.ws.name } });
}
