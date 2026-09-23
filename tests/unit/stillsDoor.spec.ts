import { test, expect } from "@playwright/test";
import { stillsDoor } from "../../lib/gemini";
import { billedTo, getProvider, providerVia } from "../../lib/providers";

/**
 * Owner, 23 September: Nano Banana bills as a Google AI charge — the Gemini
 * key is on Vercel. With a key the still goes to Google and the ledger says
 * Google, whatever STILLS_VIA says; the AI Gateway is only the no-key fallback.
 */
const ENV = ["GEMINI_API_KEY", "AI_GATEWAY_API_KEY", "STILLS_VIA", "ENGINE_MOCK", "VERCEL", "VERCEL_OIDC_TOKEN"] as const;
function withEnv(values: Partial<Record<(typeof ENV)[number], string>>, run: () => void) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  try {
    for (const name of ENV) delete process.env[name];
    Object.assign(process.env, values);
    run();
  } finally {
    for (const name of ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
}
const route = () => ({ door: stillsDoor(), billed: billedTo("google"), via: providerVia(getProvider("google")) });

test("with a Gemini key, Nano Banana goes to Google and bills to Google even when the gateway is reachable", () => {
  withEnv({ GEMINI_API_KEY: "test-gemini", AI_GATEWAY_API_KEY: "test-gateway" }, () => {
    expect(route()).toEqual({ door: "google", billed: "google", via: "key" });
  });
});

test("the gateway carries Nano Banana only without a key; STILLS_VIA cannot move a keyed still off Google", () => {
  withEnv({ AI_GATEWAY_API_KEY: "test-gateway" }, () => {
    expect(route()).toEqual({ door: "gateway", billed: "vercel", via: "gateway" });
  });
  for (const value of ["gateway", "google", "vercel"]) withEnv({ GEMINI_API_KEY: "test-gemini", AI_GATEWAY_API_KEY: "test-gateway", STILLS_VIA: value }, () => {
    expect(route()).toEqual({ door: "google", billed: "google", via: "key" });
  });
  withEnv({}, () => {
    expect(route()).toEqual({ door: null, billed: "google", via: null });
  });
});
