/**
 * NEEDS AKSHAY · "Continue with Google" (docs/redesign/inventory.md § 8.3). Particl has no Google sign-in today: it
 * needs an OAuth client (a client id and secret in the environment) and a callback route that maps a Google account to
 * an invitation, which is sign-in work for the owner. Until then the button is not drawn anywhere (owner, 11 Oct): the join
 * sheet offers Continue with email alone, which runs today's invitation pages unchanged. When Google sign-in exists, `ready`
 * turns true, the button comes back beside it and starts that flow.
 */
export const GOOGLE_SIGN_IN = {
  ready: false,
} as const;
