/**
 * What a person is told when "Continue with Google" cannot sign them in (lib/googleSignIn.ts). Plain words, no codes, and nothing that
 * says whether an address has an account. Pure, so the sign-in page and the join sheet read the same words.
 */
export const GOOGLE_REFUSALS = {
  off: "Google sign-in isn’t available.",
  expired: "That sign-in took too long or was already used. Start again.",
  denied: "Google sign-in was cancelled.",
  unavailable: "Google could not be reached. Try again in a moment.",
  unverified: "Google has not verified that email address, so it can’t be used to sign in.",
  no_account: "This Google account isn’t on Particl. Particl is invite-only: use the invite you were sent.",
  invite_invalid: "That invite isn’t valid, or it was already used or has expired.",
  invite_mismatch: "That invite was sent to a different email address than this Google account.",
  signup_invite: "That invite sets up a new workspace. Use Continue with email for it.",
  policy: "Read the content policy and terms to join, then try again.",
  two_step: "This account uses two-step sign-in. Sign in with your email, password and code.",
  limited: "Too many attempts. Try again later.",
} as const;
export type GoogleRefusal = keyof typeof GOOGLE_REFUSALS;
export const isGoogleRefusal = (value: unknown): value is GoogleRefusal => typeof value === "string" && Object.prototype.hasOwnProperty.call(GOOGLE_REFUSALS, value);


/** The address that starts "Continue with Google": `invite` a team invitation's code, `accept` the content policy and terms accepted where the button is, `next` where to land. */
export function googleStartPath(input: { invite?: string; accept?: boolean; next?: string }): string {
  const query = new URLSearchParams();
  if (input.invite) query.set("invite", input.invite);
  if (input.accept) query.set("accept", "1");
  if (input.next) query.set("next", input.next);
  const text = query.toString();
  return `/api/auth/google/start${text ? `?${text}` : ""}`;
}
