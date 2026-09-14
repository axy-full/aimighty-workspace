import { cookies } from "next/headers";
import { currentContext, SESSION_COOKIE } from "@/lib/auth";
import { accountRequestScopeMatches } from "@/lib/accountRequestScope";
import {
  accountFailure,
  accountJson,
  sameOriginProblem,
} from "@/lib/accountDb";
import {
  changeAccountSecurity,
  readAccountSecurity,
  type SecurityChange,
} from "@/lib/accountSecurity";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
async function captured(req: Request) {
  if (req.headers.has("authorization"))
    return {
      response: json(
        { error: "Use your browser session for account security." },
        403,
      ),
    };
  const context = await currentContext(),
    session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!context || !session)
    return {
      response: json({ error: "Sign in to manage account security." }, 401),
    };
  if (!accountRequestScopeMatches(req, context))
    return {
      response: json(
        {
          error: "Your account or workspace changed. Reload security settings.",
        },
        409,
      ),
    };
  return { context, session, scope: req.headers.get("X-Workbench-Scope")! };
}
export async function GET(req: Request) {
  try {
    const got = await captured(req);
    if (got.response) return got.response;
    return json(
      await readAccountSecurity(got.context.user.id, got.session, got.scope),
    );
  } catch (error) {
    return accountFailure(error);
  }
}
export async function POST(req: Request) {
  if (sameOriginProblem(req))
    return json({ error: "Invalid request origin." }, 403);
  try {
    const got = await captured(req);
    if (got.response) return got.response;
    const body = await accountJson(req);
    if (
      ![
        "begin",
        "enable",
        "disable",
        "rotate_codes",
        "activate_codes",
        "revoke_session",
        "revoke_others",
      ].includes(String(body.action))
    )
      return json({ error: "Choose a valid security action." }, 400);
    const result = await changeAccountSecurity({
      accountId: got.context.user.id,
      session: got.session,
      requestScope: got.scope,
      password: String(body.password ?? ""),
      code: String(body.code ?? ""),
      action: body.action as SecurityChange,
      sessionId: String(body.sessionId ?? ""),
      batchId: String(body.batchId ?? ""),
    });
    const { session, ...publicResult } = result;
    if (session)
      (await cookies()).set(SESSION_COOKIE, session, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 30 * 86400,
      });
    return json(publicResult);
  } catch (error) {
    return accountFailure(error);
  }
}
