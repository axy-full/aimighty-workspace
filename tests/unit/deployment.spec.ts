import { test, expect } from "@playwright/test";
import { deployedCommit, deploymentEnv, deploymentLabel, deploymentSetting, isProductionDeployment, onVercel } from "../../lib/deployment";
import { deploymentReadiness } from "../../lib/deploymentReadiness";
import { billingConfiguration } from "../../lib/billingConfig";

/*
 * Production-only behaviour asks lib/deployment.ts, not VERCEL_ENV directly.
 * On Vercel the answers must be exactly what VERCEL_ENV gave before; off
 * Vercel PARTICL_DEPLOYMENT=production|staging|development names the server,
 * and unset means development (production-only paths stay off, as before).
 * Pure functions and process.env only; nothing is billed or called.
 */
type Env = Record<string, string | undefined>;
const VERCELS = [undefined, "", "1"];
const VERCEL_ENVS = [undefined, "", "production", "preview", "development", "custom"];
const SETTINGS = [undefined, "", "production", "staging", "development", " Production ", "STAGING", "prod", "live"];
function* every(): Generator<Env> {
  for (const VERCEL of VERCELS) for (const VERCEL_ENV of VERCEL_ENVS) for (const PARTICL_DEPLOYMENT of SETTINGS)
    yield { VERCEL, VERCEL_ENV, PARTICL_DEPLOYMENT };
}
/** What every production check read before this change. */
const productionBefore = (env: Env) => env.VERCEL_ENV === "production";
const vercel = (env: Env) => Boolean(env.VERCEL || env.VERCEL_ENV);

test("the helper's truth table", () => {
  const rows: [Env, ReturnType<typeof deploymentEnv>][] = [
    [{ VERCEL: "1", VERCEL_ENV: "production" }, "production"],
    [{ VERCEL: "1", VERCEL_ENV: "production", PARTICL_DEPLOYMENT: "staging" }, "production"],
    [{ VERCEL: "1", VERCEL_ENV: "preview" }, "preview"],
    [{ VERCEL: "1", VERCEL_ENV: "preview", PARTICL_DEPLOYMENT: "production" }, "preview"],
    [{ VERCEL: "1", VERCEL_ENV: "development" }, "development"],
    [{ VERCEL: "1" }, "development"],
    [{ VERCEL: "1", PARTICL_DEPLOYMENT: "production" }, "development"],
    [{ VERCEL_ENV: "production" }, "production"],
    [{ VERCEL_ENV: "preview", PARTICL_DEPLOYMENT: "production" }, "preview"],
    [{ PARTICL_DEPLOYMENT: "production" }, "production"],
    [{ PARTICL_DEPLOYMENT: " Production " }, "production"],
    [{ PARTICL_DEPLOYMENT: "staging" }, "staging"],
    [{ PARTICL_DEPLOYMENT: "development" }, "development"],
    [{}, "development"],
    [{ PARTICL_DEPLOYMENT: "" }, "development"],
    [{ PARTICL_DEPLOYMENT: "prod" }, "development"],
    [{ PARTICL_DEPLOYMENT: "preview" }, "development"],
  ];
  for (const [env, expected] of rows) {
    expect(deploymentEnv(env), JSON.stringify(env)).toBe(expected);
    expect(isProductionDeployment(env), JSON.stringify(env)).toBe(expected === "production");
  }
  expect(deploymentSetting({})).toBe("unset");
  expect(deploymentSetting({ PARTICL_DEPLOYMENT: "  " })).toBe("unset");
  expect(deploymentSetting({ PARTICL_DEPLOYMENT: "prod" })).toBe("invalid");
  expect(deploymentSetting({ PARTICL_DEPLOYMENT: "STAGING" })).toBe("staging");
});

test("on Vercel, and wherever PARTICL_DEPLOYMENT is unset, production is exactly VERCEL_ENV === production, as before", () => {
  for (const env of every()) {
    const label = JSON.stringify(env);
    if (vercel(env) || !env.PARTICL_DEPLOYMENT?.trim()) expect(isProductionDeployment(env), label).toBe(productionBefore(env));
    // On Vercel the setting is ignored entirely.
    if (vercel(env)) {
      expect(deploymentEnv(env), label).toBe(deploymentEnv({ VERCEL: env.VERCEL, VERCEL_ENV: env.VERCEL_ENV }));
      expect(onVercel(env), label).toBe(true);
    }
  }
});

test("log and probe labels: raw VERCEL_ENV on Vercel, the named deployment off it", () => {
  expect(deploymentLabel({ VERCEL: "1", VERCEL_ENV: "preview", PARTICL_DEPLOYMENT: "production" })).toBe("preview");
  expect(deploymentLabel({ VERCEL: "1", VERCEL_ENV: "custom" })).toBe("custom");
  expect(deploymentLabel({ VERCEL: "1" })).toBe("development");
  expect(deploymentLabel({ VERCEL: "1", NODE_ENV: "production" }, "production")).toBe("production");
  expect(deploymentLabel({ VERCEL: "1", VERCEL_ENV: "" })).toBe("");
  expect(deploymentLabel({ PARTICL_DEPLOYMENT: "staging" })).toBe("staging");
  expect(deploymentLabel({ PARTICL_DEPLOYMENT: "production" }, "x")).toBe("production");
  expect(deploymentLabel({})).toBe("development");
});

/* billingConfiguration reads process.env; each case sets exactly these names and puts them back. */
const BILLING_ENV = ["PAYMENT_PROVIDER", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "APP_ORIGIN", "VERCEL", "VERCEL_ENV", "PARTICL_DEPLOYMENT"] as const;
function withBillingEnv<T>(env: Env, fn: () => T): T {
  const saved = Object.fromEntries(BILLING_ENV.map((k) => [k, process.env[k]]));
  try {
    for (const k of BILLING_ENV) { const v = env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const STRIPE = { PAYMENT_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_fixture", APP_ORIGIN: "https://billing.example.test" };
const TEST_KEY = "sk_test_fixture";
const LIVE_KEY = "sk_live_fixture";

test("billing refuses a sandbox key on a self-hosted production server, and allows it on staging", () => {
  const configured = (env: Env) => withBillingEnv({ ...STRIPE, ...env }, () => billingConfiguration());
  expect(configured({ PARTICL_DEPLOYMENT: "production", STRIPE_SECRET_KEY: TEST_KEY })).toEqual({ configured: false, reason: "Online billing is awaiting activation." });
  expect(configured({ PARTICL_DEPLOYMENT: "production", STRIPE_SECRET_KEY: LIVE_KEY })).toEqual({ configured: true, reason: null });
  expect(configured({ PARTICL_DEPLOYMENT: "staging", STRIPE_SECRET_KEY: TEST_KEY })).toEqual({ configured: true, reason: null });
  expect(configured({ PARTICL_DEPLOYMENT: "development", STRIPE_SECRET_KEY: TEST_KEY })).toEqual({ configured: true, reason: null });
  expect(configured({ STRIPE_SECRET_KEY: TEST_KEY })).toEqual({ configured: true, reason: null }); // unset: as before
  // On Vercel the setting is ignored: a preview stays a preview, production stays production.
  expect(configured({ VERCEL: "1", VERCEL_ENV: "preview", PARTICL_DEPLOYMENT: "production", STRIPE_SECRET_KEY: TEST_KEY }).configured).toBe(true);
  expect(configured({ VERCEL: "1", VERCEL_ENV: "production", PARTICL_DEPLOYMENT: "staging", STRIPE_SECRET_KEY: TEST_KEY }).configured).toBe(false);
});

test("billing on every VERCEL / VERCEL_ENV shape answers exactly as before", () => {
  for (const env of every()) for (const STRIPE_SECRET_KEY of [TEST_KEY, LIVE_KEY]) {
    if (!vercel(env) && env.PARTICL_DEPLOYMENT?.trim()) continue; // the new, off-Vercel cases are above
    const label = JSON.stringify({ ...env, STRIPE_SECRET_KEY });
    const before = !(productionBefore(env) && !STRIPE_SECRET_KEY.startsWith("sk_live_"));
    expect(withBillingEnv({ ...STRIPE, ...env, STRIPE_SECRET_KEY }, () => billingConfiguration()).configured, label).toBe(before);
  }
});

const READY = {
  PLATFORM_DATABASE_URL: "libsql://fixture.example", PLATFORM_AUTH_TOKEN: "fixture", TURSO_API_TOKEN: "fixture", TURSO_ORG: "fixture",
  KEYRING_SECRET: "x".repeat(32), BLOB_READ_WRITE_TOKEN: "fixture", RESEND_API_KEY: "fixture", MAIL_FROM: "ops@example.test",
  APP_ORIGIN: "https://example.test", CRON_SECRET: "fixture", PAYMENT_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
};
const check = (env: Env, id: string) => deploymentReadiness(env).checks.find((c) => c.id === id);

test("readiness: a self-hosted production server wants the live key and real engines; staging the sandbox key", () => {
  const prod = { ...READY, PARTICL_DEPLOYMENT: "production" };
  expect(check({ ...prod, STRIPE_SECRET_KEY: TEST_KEY }, "billing")?.ready).toBe(false);
  expect(check({ ...prod, STRIPE_SECRET_KEY: LIVE_KEY }, "billing")?.ready).toBe(true);
  expect(check({ ...prod, ENGINE_MOCK: "1" }, "generation")).toMatchObject({ ready: false, required: true });
  expect(deploymentReadiness({ ...prod, STRIPE_SECRET_KEY: LIVE_KEY }).ready).toBe(true);
  expect(deploymentReadiness({ ...prod, STRIPE_SECRET_KEY: LIVE_KEY, ENGINE_MOCK: "1" }).ready).toBe(false);
  const staging = { ...READY, PARTICL_DEPLOYMENT: "staging" };
  expect(check({ ...staging, STRIPE_SECRET_KEY: TEST_KEY }, "billing")?.ready).toBe(true);
  expect(check({ ...staging, STRIPE_SECRET_KEY: LIVE_KEY }, "billing")?.ready).toBe(false);
  expect(check({ ...staging, ENGINE_MOCK: "1" }, "generation")).toMatchObject({ ready: false, required: false });
  expect(deploymentReadiness({ ...staging, STRIPE_SECRET_KEY: TEST_KEY, ENGINE_MOCK: "1" }).ready).toBe(true);
  // Off Vercel the setting is reported; a value it does not recognise fails readiness instead of passing as development.
  expect(check(staging, "deployment")).toMatchObject({ ready: true, required: true });
  expect(check({ ...READY }, "deployment")).toMatchObject({ ready: true });
  expect(check({ ...READY, PARTICL_DEPLOYMENT: "prod" }, "deployment")).toMatchObject({ ready: false, required: true });
  expect(deploymentReadiness({ ...READY, STRIPE_SECRET_KEY: TEST_KEY, PARTICL_DEPLOYMENT: "prod" }).ready).toBe(false);
  expect(JSON.stringify(deploymentReadiness({ ...prod, STRIPE_SECRET_KEY: "sk_test_PRIVATE" }))).not.toContain("PRIVATE");
});

test("readiness on every VERCEL / VERCEL_ENV shape answers exactly as before", () => {
  const IDS_BEFORE = ["database", "provisioning", "encryption", "storage", "mail", "origin", "billing", "cron", "jobs", "generation"];
  for (const env of every()) for (const STRIPE_SECRET_KEY of [TEST_KEY, LIVE_KEY]) for (const ENGINE_MOCK of [undefined, "1"]) {
    if (!vercel(env)) continue; // off Vercel is covered above
    const label = JSON.stringify({ ...env, STRIPE_SECRET_KEY, ENGINE_MOCK });
    const full = { ...READY, ...env, STRIPE_SECRET_KEY, ENGINE_MOCK };
    const result = deploymentReadiness(full);
    expect(result.checks.map((c) => c.id), label).toEqual(IDS_BEFORE);
    const mode = productionBefore(env) ? "sk_live_" : "sk_test_";
    expect(check(full, "billing")?.ready, label).toBe(STRIPE_SECRET_KEY.startsWith(mode));
    expect(check(full, "generation"), label).toMatchObject({ ready: ENGINE_MOCK !== "1", required: productionBefore(env) });
    // The setting changes nothing on Vercel.
    expect(result, label).toEqual(deploymentReadiness({ ...full, PARTICL_DEPLOYMENT: undefined }));
  }
});

test("the running commit: VERCEL_GIT_COMMIT_SHA, else GIT_COMMIT_SHA (the self-hosted image), else none", () => {
  const rows: [Env, string | null][] = [
    [{ VERCEL_GIT_COMMIT_SHA: "aaa1111", GIT_COMMIT_SHA: "bbb2222" }, "aaa1111"],
    [{ VERCEL_GIT_COMMIT_SHA: "aaa1111" }, "aaa1111"],
    [{ GIT_COMMIT_SHA: "bbb2222" }, "bbb2222"],
    [{ GIT_COMMIT_SHA: " bbb2222 " }, "bbb2222"],
    [{ VERCEL_GIT_COMMIT_SHA: "", GIT_COMMIT_SHA: "bbb2222" }, "bbb2222"],
    [{ GIT_COMMIT_SHA: "unknown" }, null], // the Dockerfile's default when the platform passes no SOURCE_COMMIT
    [{ GIT_COMMIT_SHA: "" }, null],
    [{}, null],
  ];
  for (const [env, want] of rows) expect(deployedCommit(env), JSON.stringify(env)).toBe(want);
});
