type Environment = Record<string, string | undefined>;
export type ReadinessCheck = {
  id: string;
  ready: boolean;
  required: boolean;
  detail: string;
};

/** Configuration diagnostics contain variable names and booleans, never their values. */
export function deploymentReadiness(
  env: Environment = process.env,
  options: { includeBilling?: boolean } = {},
) {
  const checks: ReadinessCheck[] = [];
  const add = (id: string, ready: boolean, detail: string, required = true) =>
    checks.push({ id, ready, required, detail });
  const remote = (value?: string) =>
    Boolean(value && /^(libsql|https):\/\//.test(value));
  add(
    "database",
    remote(env.PLATFORM_DATABASE_URL ?? env.TURSO_DATABASE_URL) &&
      Boolean(env.PLATFORM_AUTH_TOKEN ?? env.TURSO_AUTH_TOKEN),
    "Remote platform database URL and matching authentication token",
  );
  add(
    "provisioning",
    Boolean(env.TURSO_API_TOKEN && env.TURSO_ORG),
    "TURSO_API_TOKEN and TURSO_ORG for separate workspace databases",
  );
  add(
    "encryption",
    Boolean(env.KEYRING_SECRET && env.KEYRING_SECRET.length >= 32),
    "KEYRING_SECRET with at least 32 characters",
  );
  add(
    "storage",
    Boolean(env.BLOB_READ_WRITE_TOKEN),
    "Private blob storage",
  );
  add(
    "mail",
    Boolean(env.RESEND_API_KEY && env.MAIL_FROM),
    "Resend API key and verified MAIL_FROM sender",
  );
  let origin = false;
  try {
    const u = new URL(env.APP_ORIGIN ?? "");
    origin =
      u.protocol === "https:" &&
      u.pathname === "/" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash;
  } catch {
    /* missing */
  }
  add(
    "origin",
    origin,
    "APP_ORIGIN set to the canonical HTTPS application origin",
  );
  const stripeMode = env.VERCEL_ENV === "production" ? "sk_live_" : "sk_test_";
  add(
    "billing",
    env.PAYMENT_PROVIDER === "stripe" &&
      Boolean(
        env.STRIPE_SECRET_KEY?.startsWith(stripeMode) &&
        env.STRIPE_WEBHOOK_SECRET,
      ),
    "Stripe checkout key for this environment and webhook signing secret",
    options.includeBilling !== false,
  );
  add(
    "cron",
    Boolean(env.CRON_SECRET),
    "CRON_SECRET for reconciliation, billing cycles and deletion retries",
  );
  /* Background work is dispatched natively through /api/worker, which needs
     the cron secret and the canonical origin (both checked above as well).
     Inngest keys are only a requirement for a deployment that opts into it. */
  add(
    "jobs",
    env.DISPATCH_MODE === "inngest"
      ? Boolean(env.INNGEST_EVENT_KEY && env.INNGEST_SIGNING_KEY)
      : Boolean(env.CRON_SECRET) && origin,
    env.DISPATCH_MODE === "inngest"
      ? "Inngest event and signing keys for durable jobs (DISPATCH_MODE=inngest)"
      : "Native dispatch: CRON_SECRET and APP_ORIGIN for the /api/worker hand-off",
  );
  add(
    "generation",
    env.ENGINE_MOCK !== "1",
    "Production engine mocks disabled",
    env.VERCEL_ENV === "production",
  );
  return {
    ready: checks.every((check) => !check.required || check.ready),
    scope: options.includeBilling === false ? "platform_configuration" : "commercial_configuration",
    verified: false,
    checks,
  };
}
