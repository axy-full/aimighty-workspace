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
import { inviteOnlyRefusal } from "@/lib/site/settings";
import { inviteOrigin } from "@/lib/mail";
import { readSite } from "@/lib/site/settings.server";
export const dynamic = "force-dynamic";
export const POST = recoveryRoute(async function POST(req: Request) {
  if (sameOriginProblem(req))
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  try {
    /* A self-serve verification email is a self-serve sign-up: refused while sign-up is by invitation (decision 36). */
    if (!(await readSite()).openSignup) return inviteOnlyRefusal();
    const readiness = signupReadiness();
    if (!readiness.open) throw new AccountError(readiness.reason!, 503);
    /* The verification link is built only on the configured origin (lib/mail.ts › inviteOrigin); without one nothing is resent. */
    const origin = inviteOrigin(req);
    if (origin === null) throw new AccountError("Email verification is being configured. Please try again shortly.", 503);
    const body = await accountJson(req);
    const registration = await resendSignup(
      String(body.email ?? ""),
      sourceKey(req),
    );
    if (registration)
      await deliverSignupVerification(registration, origin);
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
