import { test, expect } from "@playwright/test";
import { productionIntended, vercelIdentityInProduction, vercelIdentityProblem, vercelIdentityVars } from "../../lib/vercelGuard";
import { gatewayAuth, gatewayReachable } from "../../lib/gateway";
import { deploymentIdentityAllowed } from "../../lib/vendorKeys";

/** No Vercel identity in production (lib/vercelGuard.ts): the truth table, the gateway, and what the report says. */
const NAMES = ["ENGINE_MOCK", "AI_GATEWAY_API_KEY", "VERCEL", "VERCEL_ENV", "VERCEL_OIDC_TOKEN", "PARTICL_DEPLOYMENT"] as const;
async function within<T>(env: Partial<Record<(typeof NAMES)[number], string>>, run: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  try {
    for (const n of NAMES) delete process.env[n];
    Object.assign(process.env, env);
    return await run();
  } finally { for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; } }
}

test("production is PARTICL_DEPLOYMENT=production or a Vercel production; nothing else", () => {
  expect(productionIntended({ PARTICL_DEPLOYMENT: "production" })).toBe(true);
  expect(productionIntended({ PARTICL_DEPLOYMENT: " Production " })).toBe(true);
  expect(productionIntended({ VERCEL: "1", VERCEL_ENV: "production" })).toBe(true);
  for (const env of [{}, { PARTICL_DEPLOYMENT: "staging" }, { PARTICL_DEPLOYMENT: "development" }, { PARTICL_DEPLOYMENT: "prod" }, { VERCEL: "1", VERCEL_ENV: "preview" }, { VERCEL: "1" }])
    expect(productionIntended(env), JSON.stringify(env)).toBe(false);
});

test("VERCEL or VERCEL_OIDC_TOKEN set in production is a problem, named and never valued; outside production it is not", () => {
  expect(vercelIdentityInProduction({ PARTICL_DEPLOYMENT: "production", VERCEL: "1" })).toEqual(["VERCEL"]);
  expect(vercelIdentityInProduction({ PARTICL_DEPLOYMENT: "production", VERCEL_OIDC_TOKEN: "secret-token-value" })).toEqual(["VERCEL_OIDC_TOKEN"]);
  expect(vercelIdentityInProduction({ PARTICL_DEPLOYMENT: "production", VERCEL: "1", VERCEL_OIDC_TOKEN: "x" })).toEqual(["VERCEL", "VERCEL_OIDC_TOKEN"]);
  expect(vercelIdentityInProduction({ VERCEL: "1", VERCEL_ENV: "production" })).toEqual(["VERCEL"]);
  expect(vercelIdentityProblem({ PARTICL_DEPLOYMENT: "production", VERCEL_OIDC_TOKEN: "secret-token-value" })).not.toContain("secret-token-value");
  expect(vercelIdentityProblem({ PARTICL_DEPLOYMENT: "production", VERCEL: "1" })).toContain("VERCEL");
  /* Clean production, blanks, staging, preview, development: no problem. */
  for (const env of [{ PARTICL_DEPLOYMENT: "production" }, { PARTICL_DEPLOYMENT: "production", VERCEL: "", VERCEL_OIDC_TOKEN: "  " }, { PARTICL_DEPLOYMENT: "staging", VERCEL: "1" }, { VERCEL: "1", VERCEL_ENV: "preview", VERCEL_OIDC_TOKEN: "x" }, { VERCEL: "1" }])
    expect(vercelIdentityProblem(env), JSON.stringify(env)).toBeNull();
  expect(vercelIdentityVars({ VERCEL: "1" })).toEqual(["VERCEL"]);
});

test("in production the gateway opens only with AI_GATEWAY_API_KEY: the deployment identity is never used, set or not", async () => {
  for (const env of [{ PARTICL_DEPLOYMENT: "production" }, { PARTICL_DEPLOYMENT: "production", VERCEL: "1", VERCEL_OIDC_TOKEN: "t" }, { VERCEL: "1", VERCEL_ENV: "production", VERCEL_OIDC_TOKEN: "t" }]) {
    await within(env, async () => {
      expect(deploymentIdentityAllowed()).toBe(false);
      expect(gatewayReachable(), JSON.stringify(env)).toBe(false);
      await expect(gatewayAuth()).rejects.toThrow();
    });
  }
  await within({ PARTICL_DEPLOYMENT: "production", AI_GATEWAY_API_KEY: "a-key" }, async () => {
    expect(gatewayReachable()).toBe(true);
    expect(await gatewayAuth()).toEqual({ Authorization: "Bearer a-key" });
  });
});

test("outside production nothing changes: a Vercel identity still opens the gateway (previews, development)", async () => {
  await within({ VERCEL: "1", VERCEL_ENV: "preview" }, () => { expect(deploymentIdentityAllowed()).toBe(true); expect(gatewayReachable()).toBe(true); });
  await within({ VERCEL_OIDC_TOKEN: "t" }, () => { expect(gatewayReachable()).toBe(true); });
  await within({}, () => { expect(gatewayReachable()).toBe(false); });
});
