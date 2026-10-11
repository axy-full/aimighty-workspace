/**
 * No Vercel identity in production (owner's decision, 11 October 2026: the Vercel AI gateway is removed, and the privacy page says
 * each AI service is reached directly).
 *
 * Production is the self-hosted server, named `PARTICL_DEPLOYMENT=production` (lib/deployment.ts), or a Vercel deployment whose
 * `VERCEL_ENV` is production. In production:
 *  - `VERCEL` and `VERCEL_OIDC_TOKEN` must not be set: they are what lets a deployment open the gateway with no key of its own.
 *    Their presence fails `/api/health` (so a deploy's health check rolls it back), is reported by the platform owner's readiness
 *    read (`/api/admin/readiness`) and is logged at boot (instrumentation.ts);
 *  - the deployment identity is never used, whatever is set: the gateway is reachable only with `AI_GATEWAY_API_KEY`
 *    (lib/vendorKeys.ts › deploymentIdentityAllowed, read by lib/gateway.ts).
 * Pure: no database, no network; the names are reported, never their values.
 */
type Environment = Record<string, string | undefined>;

/** The two variables that give a deployment a Vercel identity. */
export const VERCEL_IDENTITY_VARS = ["VERCEL", "VERCEL_OIDC_TOKEN"] as const;

/** Whether this is production by either of the ways a server says so (a Vercel production, or PARTICL_DEPLOYMENT=production). */
export function productionIntended(env: Environment = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.PARTICL_DEPLOYMENT?.trim().toLowerCase() === "production";
}

/** The names of the Vercel identity variables that are set (non-empty), whatever the deployment. */
export function vercelIdentityVars(env: Environment = process.env): string[] {
  return VERCEL_IDENTITY_VARS.filter((name) => Boolean(env[name]?.trim()));
}

/** The Vercel identity variables set in production: empty when this is not production or none is set. */
export function vercelIdentityInProduction(env: Environment = process.env): string[] {
  return productionIntended(env) ? vercelIdentityVars(env) : [];
}

/** The sentence for a log or a readiness read, or null when all is well. Names only. */
export function vercelIdentityProblem(env: Environment = process.env): string | null {
  const names = vercelIdentityInProduction(env);
  return names.length ? `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} set in production. Production has no Vercel identity: remove ${names.length === 1 ? "it" : "them"}.` : null;
}
