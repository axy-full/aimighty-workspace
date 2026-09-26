import { recoveryRoute } from "@/lib/recovery";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, currentContext } from "@/lib/auth";
import { accountInvitationSession } from "@/lib/accountInvitationSession";
import {
  platformDb,
  platformReady,
  findAccountByEmail,
  getWorkspace,
  now,
  switchSessionWorkspace,
} from "@/lib/platform";
import {
  acceptWorkspaceInvitation,
  mailboxProven,
  mailWorkspaceInvite,
  MailboxProofNeeded,
} from "@/lib/teamInvitations";
import { mailConfigured, sendMail, inviteEmail, inviteOrigin } from "@/lib/mail";
import { policyAccepted } from "@/lib/policyAccept";
import {
  accountFailure,
  accountJson,
  sameOriginProblem,
  AccountError,
} from "@/lib/accountDb";

export const dynamic = "force-dynamic";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function lookup(code: string) {
  const inv = (
    await platformDb().execute({
      sql: `SELECT * FROM workspace_invites WHERE code = ? LIMIT 1`,
      args: [code],
    })
  ).rows[0] as any;
  if (!inv)
    return { problem: "That invite link isn't valid.", status: 404 } as const;
  if (inv.used_at)
    return {
      problem: "That invite has already been used.",
      status: 409,
    } as const;
  if (Number(inv.expires_at) < now())
    return {
      problem: "That invite has expired. Ask for a new one.",
      status: 410,
    } as const;
  const ws = await getWorkspace(String(inv.workspace_id));
  if (!ws || ws.deletedAt)
    return {
      problem: "That workspace no longer exists.",
      status: 410,
    } as const;
  return { inv, ws } as const;
}

/** What the invite is for, and whether the address already has an account. */
export const GET = recoveryRoute(async function GET(req: Request) {
  await platformReady();
  const query = new URL(req.url).searchParams,
    code = query.get("code") ?? "";
  const got = await lookup(code);
  if ("problem" in got)
    return NextResponse.json({ error: got.problem }, { status: got.status });
  const existing = await findAccountByEmail(String(got.inv.email));
  const ctx = await currentContext();
  return NextResponse.json({
    ok: true,
    workspace: got.ws.name,
    email: got.inv.email,
    name: got.inv.name,
    role: got.inv.role,
    hasAccount: Boolean(existing),
    // A new account is made only from the link in the invitation's email.
    mailboxNeeded:
      !existing && mailConfigured() && !mailboxProven(code, query.get("m")),
    signedInAsInvitee: Boolean(
      ctx &&
      ctx.user.email.toLowerCase() === String(got.inv.email).toLowerCase(),
    ),
  });
});

/**
 * The invited address asks for its invitation email: opening the link in
 * that email is what proves the mailbox before a new account is made. It
 * only ever goes to the address the invitation names, within the same caps
 * as an admin's re-send.
 */
async function emailLink(req: Request, body: Record<string, unknown>) {
  const got = await lookup(String(body.code ?? "").trim());
  if ("problem" in got)
    return Response.json({ error: got.problem }, { status: got.status });
  if (!mailConfigured())
    return Response.json(
      { error: "Email isn't set up on this deployment." },
      { status: 400 },
    );
  const inviter = (
    await platformDb().execute({
      sql: "SELECT name FROM accounts WHERE id=?",
      args: [String(got.inv.created_by ?? "")],
    })
  ).rows[0];
  const origin = inviteOrigin(req);
  try {
    await mailWorkspaceInvite({
      ws: got.ws,
      code: String(got.inv.code),
      origin,
      deliver: (to, link) =>
        sendMail({
          to,
          ...inviteEmail({
            name: String(got.inv.name),
            inviter: inviter
              ? `${String(inviter.name)} (${got.ws.name})`
              : got.ws.name,
            link,
            role: String(got.inv.role),
            expiresAt: Number(got.inv.expires_at),
            origin,
          }),
        }),
    });
  } catch (error) {
    if (error instanceof AccountError && error.status === 429)
      return Response.json(
        {
          error:
            "This invitation can't be emailed again for now. Ask for a new one.",
        },
        { status: 429 },
      );
    if (error instanceof AccountError) return accountFailure(error);
    return Response.json(
      { error: "The email could not be sent. Try again in a moment." },
      { status: 502 },
    );
  }
  return Response.json({ ok: true, sent: true });
}

/**
 * Join the workspace. A new person chooses a password and gets an account;
 * someone who already has one joins while signed in as that account.
 */
export const POST = recoveryRoute(async function POST(req: Request) {
  if (sameOriginProblem(req))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const body = await accountJson(req),
      ctx = await currentContext(),
      jar = await cookies(),
      signedInSession = jar.get(SESSION_COOKIE)?.value;
    if (body.emailLink === true) return await emailLink(req, body);
    const joined = await acceptWorkspaceInvitation({
      code: String(body.code ?? "").trim(),
      password: String(body.password ?? ""),
      name: String(body.name ?? ""),
      acceptedPolicy: policyAccepted(body),
      signedInAccountId: ctx?.user.id,
      signedInSession,
      mailboxProof: typeof body.m === "string" ? body.m : undefined,
      requireMailboxProof: mailConfigured(),
    });
    const { session: token, created } = await accountInvitationSession(
      joined.accountId,
      ctx?.user.id,
      signedInSession,
    );
    if (created)
      jar.set(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 30 * 86400,
      });
    await switchSessionWorkspace(token, joined.workspace.id);
    return Response.json({
      ok: true,
      workspace: { id: joined.workspace.id, name: joined.workspace.name },
    });
  } catch (error) {
    if (error instanceof MailboxProofNeeded)
      return Response.json(
        { error: error.message, needsMailbox: true },
        { status: 403 },
      );
    if (error instanceof AccountError && error.status === 409)
      return Response.json(
        { error: error.message, needsSignIn: true },
        { status: 409 },
      );
    return accountFailure(error);
  }
});
