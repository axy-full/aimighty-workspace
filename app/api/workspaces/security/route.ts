import { cookies } from "next/headers";
import { withTenant, requireSession, SESSION_COOKIE } from "@/lib/auth";
import { accountFailure, accountJson } from "@/lib/accountDb";
import {
  changeWorkspaceSecurity,
  readWorkspaceSecurity,
} from "@/lib/accountSecurity";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
async function captured(
  req: Request,
): Promise<
  | { response: Response }
  | { accountId: string; session: string; requestScope: string }
> {
  if (req.headers.has("authorization"))
    return {
      response: json(
        { error: "Use your browser session for workspace security." },
        403,
      ),
    };
  const got = await requireSession();
  if (got.response) return { response: got.response };
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const requestScope = req.headers.get("X-Workbench-Scope");
  if (!session || !requestScope)
    return {
      response: json(
        { error: "Reload workspace security before continuing." },
        409,
      ),
    };
  return { accountId: got.user.id, session, requestScope };
}
export const GET = withTenant(async (req: Request) => {
  try {
    const got = await captured(req);
    if ("response" in got) return got.response;
    return json(
      await readWorkspaceSecurity(got.accountId, got.session, got.requestScope),
    );
  } catch (error) {
    return accountFailure(error);
  }
});
export const POST = withTenant(
  async (req: Request) => {
    try {
      const got = await captured(req);
      if ("response" in got) return got.response;
      const body = await accountJson(req);
      if (typeof body.requiresMfa !== "boolean")
        return json(
          { error: "Choose whether this workspace requires two-step sign-in." },
          400,
        );
      return json(
        await changeWorkspaceSecurity({
          accountId: got.accountId,
          session: got.session,
          requestScope: got.requestScope,
          password: String(body.password ?? ""),
          code: String(body.code ?? ""),
          requiresMfa: body.requiresMfa,
        }),
      );
    } catch (error) {
      return accountFailure(error);
    }
  },
  { requireRequestScope: true },
);
