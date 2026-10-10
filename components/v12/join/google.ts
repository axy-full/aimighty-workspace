/**
 * NEEDS AKSHAY · "Continue with Google" (docs/redesign/inventory.md § 8.3). Particl has no Google sign-in today: it
 * needs an OAuth client (a client id and secret in the environment) and a callback route that maps a Google account to
 * an invitation, which is sign-in work for the owner. Until then the button says so and points to Continue with email,
 * which runs today's invitation pages unchanged. When it exists, `ready` turns true and the button starts that flow.
 */
export const GOOGLE_SIGN_IN = {
  ready: false,
  notYet: "Google sign-in isn’t on yet. Use Continue with email.",
} as const;
