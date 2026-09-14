# Account security

`/account/security` manages account-wide authenticator enrollment, recovery codes and active browser sessions. Enrollment verifies a six-digit TOTP before enabling it, encrypts the account-bound secret, rejects replayed counters and replaces all previous sessions. Password-only login cannot issue a session for an enrolled account. Authenticator applications can use the setup key or the `otpauth` link.

Recovery codes are random, hashed, account-bound and single-use. Replacement is staged: unused old codes remain valid until the same browser confirms saving the new set. An interrupted replacement resumes the exact set with fresh password proof. A prepared set follows that browser's cookie when it revokes other sessions; revoking sessions with the final remaining recovery code is refused atomically so a lost cookie response cannot cause lockout.

A successful recovery-code login provides a server-only ten-minute authorization to replace backup codes using the current password. This permits recovery after the final code is consumed. The authorization is bound to the account, session, password fingerprint and MFA epoch; it cannot disable MFA or revoke sessions. Activation consumes outstanding replacement authorizations. Expired or other-session proof cannot substitute for a factor.

Password reset preserves MFA and revokes previous sessions. An enrolled user signs in again with their authenticator or an unused recovery code. Invitation acceptance for an existing enrolled account requires its currently verified session and checks it again in the membership transaction. Security settings accept only browser sessions with same-origin and captured account/workspace scope; bearer tokens cannot manage factors. Account/session changes revalidate under a transaction and write a security audit receipt.

Additive platform tables hold account security, recovery hashes, staged encrypted batches, narrow replacement authorizations and per-session verification epochs. This release does not claim SAML/OIDC federation, SCIM, WebAuthn/passkeys or a mandatory workspace MFA policy.

Verification includes RFC6238 vectors, concurrent factor use, rollback on audit failure, reset/invitation boundaries, staged replacement, final-code recovery and lost-response browser flows. No production account is enrolled by a test.
