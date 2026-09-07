/** Sign-up says so in one boolean: the content policy and terms were read. Pure. */
export function policyAccepted(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && (body as { accept?: unknown }).accept === true);
}
