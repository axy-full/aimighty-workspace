/** Sign-up says so in one boolean: since 15 Oct 2026 the 18+ and Terms tick (lib/ageConfirm.ts, which this is the same key as). Pure. */
export function policyAccepted(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && (body as { accept?: unknown }).accept === true);
}
