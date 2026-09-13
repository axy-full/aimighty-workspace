import { test, expect } from "@playwright/test";
import { deploymentReadiness } from "../../lib/deploymentReadiness";
import { subscriptionPriceCents, billingOrigin } from "../../lib/billingConfig";

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
