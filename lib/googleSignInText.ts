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
  use_email: "Use Continue with email for this address: Google only vouches for Gmail addresses and verified Google Workspace domains.",
  no_account: "This Google account isn’t on Particl. Particl is invite-only: use the invite you were sent.",
  invite_invalid: "That invite isn’t valid, or it was already used or has expired.",
  full: "That workspace has no free seats. Ask its admin.",
  invite_mismatch: "That invite was sent to a different email address than this Google account.",
  signup_invite: "That invite sets up a new workspace. Use Continue with email for it.",
  policy: "Confirm you're 18 or older and agree to the Terms to join, then try again.",
  two_step: "This account uses two-step sign-in. Sign in with your email, password and code.",
  limited: "Too many attempts. Try again later.",
} as const;
export type GoogleRefusal = keyof typeof GOOGLE_REFUSALS;
export const isGoogleRefusal = (value: unknown): value is GoogleRefusal => typeof value === "string" && Object.prototype.hasOwnProperty.call(GOOGLE_REFUSALS, value);


export const GOOGLE_START = "/api/auth/google/start";

/** The link that starts a plain "Continue with Google" (the sign-in page): `next` where to land. It never carries an invite. */
export function googleStartPath(input: { next?: string }): string {
  return input.next ? `${GOOGLE_START}?${new URLSearchParams({ next: input.next })}` : GOOGLE_START;
}

/**
 * The fields of the join sheet's form, POSTed to GOOGLE_START: `invite` a team invitation's code, `accept` the content policy and terms
 * accepted on the sheet, `next` where to land. Only a POST from Particl's own page keeps the invite (lib/googleSignIn.ts startIntent).
 */
export function googleJoinFields(input: { invite: string; next?: string }): Record<string, string> {
  return { invite: input.invite, accept: "1", ...(input.next ? { next: input.next } : {}) };
}
