/**
 * Which deployment this server is: the one place production-only behaviour
 * asks "is this production?".
 *
 * - On Vercel (`VERCEL` or `VERCEL_ENV` set; Vercel sets both): exactly
 *   `VERCEL_ENV`, as every caller read it before this helper existed.
 *   `PARTICL_DEPLOYMENT` is ignored there.
 * - Off Vercel (self-hosted, local, CI): the explicit server-side setting
 *   `PARTICL_DEPLOYMENT=production|staging|development` (runtime variable,
 *   never a build variable, never derived from a request). Unset means
 *   "development", which keeps every production-only path off: the same
 *   result as before this setting existed. Any other value is also treated
 *   as "development" and is reported by deployment readiness, so a typo is
 *   visible instead of silently switching a guard.
 *
 *   VERCEL  VERCEL_ENV    PARTICL_DEPLOYMENT  deploymentEnv   production?
 *   set     production    (ignored)           production      yes
 *   set     preview       (ignored)           preview         no
 *   set     development   (ignored)           development     no
 *   set     unset/other   (ignored)           development     no
 *   unset   production    (ignored)           production      yes   (VERCEL_ENV alone counts as Vercel, as before)
 *   unset   preview       (ignored)           preview         no
 *   unset   unset         production          production      yes
 *   unset   unset         staging             staging         no
 *   unset   unset         development         development     no
 *   unset   unset         unset               development     no
 *   unset   unset         anything else       development     no    (readiness flags it)
 */
type Environment = Record<string, string | undefined>;

export type DeploymentEnv = "production" | "preview" | "staging" | "development";
export type DeploymentSetting = "production" | "staging" | "development" | "unset" | "invalid";

export const DEPLOYMENT_SETTING_NAME = "PARTICL_DEPLOYMENT";

/** Vercel sets VERCEL and VERCEL_ENV on every build and function; either one means Vercel. */
export function onVercel(env: Environment = process.env): boolean {
  return Boolean(env.VERCEL || env.VERCEL_ENV);
}

/** The off-Vercel setting as written (trimmed, case-insensitive). Meaningless on Vercel. */
export function deploymentSetting(env: Environment = process.env): DeploymentSetting {
  const raw = env.PARTICL_DEPLOYMENT?.trim().toLowerCase();
  if (!raw) return "unset";
  return raw === "production" || raw === "staging" || raw === "development" ? raw : "invalid";
}

export function deploymentEnv(env: Environment = process.env): DeploymentEnv {
  if (onVercel(env)) {
    if (env.VERCEL_ENV === "production") return "production";
    if (env.VERCEL_ENV === "preview") return "preview";
    return "development";
  }
  const setting = deploymentSetting(env);
  return setting === "production" || setting === "staging" ? setting : "development";
}

/** True only on Vercel production, or off Vercel with PARTICL_DEPLOYMENT=production. */
export function isProductionDeployment(env: Environment = process.env): boolean {
  return deploymentEnv(env) === "production";
}

/**
 * The environment name for logs and probe receipts. On Vercel it is the raw
 * `VERCEL_ENV` (falling back as the caller always did), so labels there are
 * unchanged; off Vercel it is the deployment above.
 */
export function deploymentLabel(env: Environment = process.env, vercelFallback = "development"): string {
  if (onVercel(env)) return env.VERCEL_ENV ?? vercelFallback;
  return deploymentEnv(env);
}
