/** Small pure helpers shared by the sign-up, sign-in and invitation pages. */

export const billingPath = (plan: string, cadence: string) =>
  `/billing?plan=${encodeURIComponent(plan)}&cadence=${cadence}&onboarding=1`;

/** Where "Sign in" leads from sign-up. With an invitation it comes back to
 * that invitation, because an existing account accepts it while signed in;
 * without one it goes on to the chosen plan. */
export function signupSignInPath(
  invite: string,
  plan: string,
  cadence: string,
): string {
  const next = invite
    ? `/signup?invite=${encodeURIComponent(invite)}`
    : billingPath(plan, cadence);
  return "/login?next=" + encodeURIComponent(next);
}

export type Answer = Record<string, unknown>;
/** Read a JSON reply without turning a gateway's HTML error page into a parse
 * error on screen. `problem` is null only for a readable, successful answer. */
export async function readAnswer(
  response: Response,
  fallback: string,
): Promise<{ data: Answer; problem: string | null }> {
  const parsed: unknown = await response.json().catch(() => null);
  const readable = Boolean(parsed) && typeof parsed === "object";
  const data = (readable ? parsed : {}) as Answer;
  if (response.ok && readable) return { data, problem: null };
  if (typeof data.error === "string" && data.error)
    return { data, problem: data.error };
  return {
    data,
    problem: readable
      ? fallback
      : `The server answered ${response.status}. Try again in a moment.`,
  };
}

/** A line for the sign-in form from where the visitor was sent from. */
export function signInNotice(params: { get(name: string): string | null }) {
  return params.get("passwordReset") === "1"
    ? "Password changed. Sign in with your new password and your authenticator code."
    : null;
}
