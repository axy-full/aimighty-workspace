import { test, expect } from "@playwright/test";
import { deploymentReadiness } from "../../lib/deploymentReadiness";
import { subscriptionPriceCents, billingOrigin } from "../../lib/billingConfig";

test("platform configuration can defer Stripe without claiming operational verification", () => {
  const env = { PLATFORM_DATABASE_URL: "libsql://fixture.example", PLATFORM_AUTH_TOKEN: "fixture",
    TURSO_API_TOKEN: "fixture", TURSO_ORG: "fixture", KEYRING_SECRET: "x".repeat(32),
    BLOB_READ_WRITE_TOKEN: "fixture", RESEND_API_KEY: "fixture", MAIL_FROM: "ops@example.test",
    APP_ORIGIN: "https://example.test", CRON_SECRET: "fixture", INNGEST_EVENT_KEY: "fixture", INNGEST_SIGNING_KEY: "fixture" };
  const core = deploymentReadiness(env, { includeBilling: false });
  expect(core.ready).toBe(true);
  expect(core.verified).toBe(false);
  expect(core.checks.find((check) => check.id === "billing")).toMatchObject({ required: false, ready: false });
  expect(deploymentReadiness(env).ready).toBe(false);
  // Native dispatch needs the cron secret and origin, not the Inngest keys; the keys only matter when opted in.
  const native = { ...env, INNGEST_EVENT_KEY: undefined, INNGEST_SIGNING_KEY: undefined };
  expect(deploymentReadiness(native, { includeBilling: false }).checks.find((c) => c.id === "jobs")).toMatchObject({ ready: true });
  expect(deploymentReadiness({ ...native, DISPATCH_MODE: "inngest" }, { includeBilling: false }).checks.find((c) => c.id === "jobs")).toMatchObject({ ready: false });
  expect(deploymentReadiness({ ...env, DISPATCH_MODE: "inngest" }, { includeBilling: false }).ready).toBe(true);
});

test("production readiness rejects sandbox billing, local storage/database, mocks and missing provisioning", () => {
  const result = deploymentReadiness({
    VERCEL_ENV: "production",
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_PRIVATE",
    STRIPE_WEBHOOK_SECRET: "whsec_PRIVATE",
    ENGINE_MOCK: "1",
    TURSO_DATABASE_URL: "file:local.db",
  });
  expect(result.ready).toBe(false);
  for (const id of [
    "database",
    "storage",
    "provisioning",
    "billing",
    "generation",
  ])
    expect(result.checks.find((c) => c.id === id)?.ready).toBe(false);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
test("retained annual pricing applies the exact 20 percent discount", () => {
  expect(subscriptionPriceCents(49, "monthly")).toBe(4900);
  expect(subscriptionPriceCents(49, "annual")).toBe(47040);
  expect(subscriptionPriceCents(199, "annual")).toBe(191040);
  expect(subscriptionPriceCents(999, "annual")).toBe(959040);
});
test("checkout origin rejects credential-bearing and attacker-controlled path origins", () => {
  const before = process.env.APP_ORIGIN;
  try {
    for (const invalid of [
      "https://user:secret@example.test",
      "https://example.test/redirect",
      "https://example.test?host=evil",
      "javascript:alert(1)",
    ]) {
      process.env.APP_ORIGIN = invalid;
      expect(billingOrigin()).toBeNull();
    }
    process.env.APP_ORIGIN = "https://example.test";
    expect(billingOrigin()).toBe("https://example.test");
  } finally {
    if (before === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = before;
  }
});

test("storage is ready when the backend the app selects is complete: R2 with all four variables, or the Blob token", () => {
  const R2 = { STORAGE_BACKEND: "r2", R2_ACCOUNT_ID: "fixture", R2_ACCESS_KEY_ID: "fixture", R2_SECRET_ACCESS_KEY: "SECRET_R2", R2_BUCKET: "fixture" };
  const storage = (env: Record<string, string | undefined>) =>
    deploymentReadiness({ PARTICL_DEPLOYMENT: "production", ...env }).checks.find((c) => c.id === "storage")?.ready;
  // R2 with no Blob token is ready (production after the Blob token is removed).
  expect(storage(R2)).toBe(true);
  // R2 missing any one of its four variables is not ready, even with a Blob token left behind.
  for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
    expect(storage({ ...R2, [name]: undefined }), name).toBe(false);
    expect(storage({ ...R2, [name]: "" }), `${name} blank`).toBe(false);
    expect(storage({ ...R2, [name]: undefined, BLOB_READ_WRITE_TOKEN: "fixture" }), `${name} with Blob token`).toBe(false);
  }
  // The Blob token alone is ready, as before; so is an explicit STORAGE_BACKEND=blob with it.
  expect(storage({ BLOB_READ_WRITE_TOKEN: "fixture" })).toBe(true);
  expect(storage({ STORAGE_BACKEND: "blob", BLOB_READ_WRITE_TOKEN: "fixture" })).toBe(true);
  expect(storage({ STORAGE_BACKEND: "blob" })).toBe(false);
  // Nothing set in production, local disk, or a backend the app refuses: not ready.
  expect(storage({})).toBe(false);
  expect(storage({ VERCEL_ENV: "production" })).toBe(false);
  expect(storage({ STORAGE_BACKEND: "local", BLOB_READ_WRITE_TOKEN: "fixture" })).toBe(false);
  expect(storage({ ...R2, STORAGE_BACKEND: "s3" })).toBe(false);
  // Names only, never values.
  expect(JSON.stringify(deploymentReadiness({ ...R2, PARTICL_DEPLOYMENT: "production" }))).not.toContain("SECRET_R2");
});
