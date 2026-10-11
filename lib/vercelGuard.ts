/**
 * No Vercel identity and no gateway key in production (owner's decision, 11 October 2026: the Vercel AI gateway is removed, and the
 * privacy page says each AI service is reached directly).
 *
 * Production is the self-hosted server, named `PARTICL_DEPLOYMENT=production` (lib/deployment.ts), or a Vercel deployment whose
 * `VERCEL_ENV` is production. In production:
 *  - `VERCEL`, `VERCEL_OIDC_TOKEN` and `AI_GATEWAY_API_KEY` must not be set: they are what opens the gateway. Their presence fails `/api/health` (so a deploy's health check rolls it back), is reported by the platform owner's readiness
 *    read (`/api/admin/readiness`) and is logged at boot (instrumentation.ts);
 *  - the gateway is closed there whatever is set: no deployment identity (lib/vendorKeys.ts › deploymentIdentityAllowed) and no key
 *    (`vendorKey("gateway")` answers nothing in production), so lib/gateway.ts, the image engines' fallback and the language provider
 *    cannot reach it.
 * Pure: no database, no network; the names are reported, never their values.
 */
type Environment = Record<string, string | undefined>;

/** The variables that open the Vercel AI gateway: the two that give a deployment a Vercel identity, and the gateway's own key. */
export const VERCEL_IDENTITY_VARS = ["VERCEL", "VERCEL_OIDC_TOKEN", "AI_GATEWAY_API_KEY"] as const;

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
  return names.length ? `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} set in production. Production has no Vercel identity or gateway key: remove ${names.length === 1 ? "it" : "them"}.` : null;
}
