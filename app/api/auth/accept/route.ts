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
import { acceptWorkspaceInvitation } from "@/lib/teamInvitations";
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
  const code = new URL(req.url).searchParams.get("code") ?? "";
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
    signedInAsInvitee: Boolean(
      ctx &&
      ctx.user.email.toLowerCase() === String(got.inv.email).toLowerCase(),
    ),
  });
});

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
    const joined = await acceptWorkspaceInvitation({
      code: String(body.code ?? "").trim(),
      password: String(body.password ?? ""),
      name: String(body.name ?? ""),
      acceptedPolicy: policyAccepted(body),
      signedInAccountId: ctx?.user.id,
      signedInSession,
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
    if (error instanceof AccountError && error.status === 409)
      return Response.json(
        { error: error.message, needsSignIn: true },
        { status: 409 },
      );
    return accountFailure(error);
  }
});
