import {recoveryRoute} from '@/lib/recovery';
import { sourceKey } from "@/lib/auth";
import {
  resendSignup,
  deliverSignupVerification,
  signupReadiness,
} from "@/lib/signupRegistration";
import {
  accountFailure,
  accountJson,
  sameOriginProblem,
  AccountError,
} from "@/lib/accountDb";
export const dynamic = "force-dynamic";
export const POST = recoveryRoute(async function POST(req: Request) {
  if (sameOriginProblem(req))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    const readiness = signupReadiness();
    if (!readiness.open) throw new AccountError(readiness.reason!, 503);
    const body = await accountJson(req);
    const registration = await resendSignup(
      String(body.email ?? ""),
      sourceKey(req),
    );
    if (registration)
      await deliverSignupVerification(
        registration,
        process.env.APP_ORIGIN?.replace(/\/$/, "") || new URL(req.url).origin,
      );
    return Response.json(
      {
        ok: true,
        message:
          "If this email has a pending signup, a new verification email is on its way.",
      },
      { status: 202 },
    );
  } catch (error) {
    return accountFailure(error);
  }
});
