import { cookies } from "next/headers";
import { SESSION_COOKIE, createSession, currentContext } from "@/lib/auth";
import { switchSessionWorkspace } from "@/lib/platform";
import { verifySignup, signupNext } from "@/lib/signupRegistration";
import { resumeWorkspace } from "@/lib/workspaceProvisioning";
import {
  accountFailure,
  accountJson,
  sameOriginProblem,
} from "@/lib/accountDb";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function POST(req: Request) {
  if (sameOriginProblem(req))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const body = await accountJson(req),
      ctx = await currentContext();
    const result = await verifySignup(String(body.token ?? ""), ctx?.user.id);
    const token = await createSession(result.owner.id);
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 30 * 86400,
    });
    const provisioned = await resumeWorkspace(
      result.requestId,
      result.owner.id,
    );
    const choice = {
      planId: result.planId,
      cadence: result.cadence,
      next: signupNext(result),
    };
    if (provisioned.workspace) {
      await switchSessionWorkspace(token, provisioned.workspace.id);
      return Response.json({
        ok: true,
        workspace: {
          id: provisioned.workspace.id,
          name: provisioned.workspace.name,
          slug: provisioned.workspace.slug,
        },
        ...choice,
      });
    }
    return Response.json(
      { ok: true, provisioning: provisioned.provisioning, ...choice },
      { status: 202 },
    );
  } catch (error) {
    return accountFailure(error);
  }
}
