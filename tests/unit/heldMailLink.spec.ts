import { test, expect } from "@playwright/test";
import { load } from "./demo-gaps-l5-harness";
import * as site from "../../lib/site";
import { SETTINGS_CREDITS } from "../../lib/shell/settings";

/**
 * The "renders are being held" email links to Settings on the configured origin (lib/site.ts), the same rule as every
 * other emailed link: APP_ORIGIN; on Vercel without it, the production deployment's domain; a self-hosted server
 * without APP_ORIGIN sends no email rather than a link with no host. There is no request here, so no header can reach it.
 */
test.describe.configure({ mode: "serial" });

const PUBLIC = "https://app.example.test";
type Env = Record<string, string | undefined>;
const SELF_HOSTED: Env = { VERCEL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined, NODE_ENV: "production", APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined };

async function withEnv<T>(patch: Env, fn: () => Promise<T> | T): Promise<T> {
  const env = process.env as Env, saved: Env = {};
  for (const key of Object.keys(patch)) { saved[key] = env[key]; if (patch[key] === undefined) delete env[key]; else env[key] = patch[key]; }
  try { return await fn(); }
  finally { for (const key of Object.keys(saved)) { if (saved[key] === undefined) delete env[key]; else env[key] = saved[key]; } }
}

/** lib/held.ts with one held take, one admin, mail set up, and everything else stood in. */
function held(sent: { to: string; text: string; html: string }[]) {
  const stub = new Proxy({}, { get: (_t, key) => key === "__esModule" ? true : () => undefined });
  const deps: Record<string, unknown> = {
    "next/server": { after: () => {} },
    "./db": { ready: async () => {}, now: () => 1, db: () => ({ execute: async () => ({ rows: [{ n: 1 }] }) }) },
    "./tenant": { currentTenant: () => ({ workspace: { id: "ws_held", name: "Studio H" } }) },
    "./platform": { workspaceAdmins: async () => [{ id: "a1", email: "admin@example.test", name: "Admin" }], membershipRole: async () => "admin" },
    "./push": { notify: async () => {} },
    "./mail": { mailConfigured: () => true, sendMail: async (msg: { to: string; text: string; html: string }) => { sent.push(msg); return { id: "m" }; } },
    "./site": site,
    "./shell/settings": { SETTINGS_CREDITS },
  };
  for (const name of ["./recovery", "./meter", "./credits", "./creditTerms", "./cinemaHold", "./generationRequests", "./inngest", "./renderWork", "./submitVideo", "./cache", "./limits", "./providerPool"]) deps[name] = stub;
  return load<typeof import("../../lib/held")>("lib/held.ts", deps);
}

test("held email: its Settings link is on APP_ORIGIN", async () => {
  const sent: { to: string; text: string; html: string }[] = [];
  await withEnv({ ...SELF_HOSTED, APP_ORIGIN: `${PUBLIC}/`, APP_URL: "https://other.example.test" }, () => held(sent).notifyHeld({ id: "g1", needs: 10, left: 2 }));
  expect(sent).toHaveLength(1);
  expect(sent[0].text).toContain(`${PUBLIC}${SETTINGS_CREDITS}`);
  expect(sent[0].html).toContain(`href="${PUBLIC}${SETTINGS_CREDITS.replace(/&/g, "&amp;")}"`);
  expect(sent[0].text).not.toContain("other.example.test");
});

test("held email: a self-hosted server without APP_ORIGIN sends none (no relative or guessed link), and says why", async () => {
  const sent: unknown[] = [];
  const lines: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await withEnv({ ...SELF_HOSTED, APP_ORIGIN: undefined }, () => held(sent as never).notifyHeld({ id: "g1", needs: 10, left: 2 }));
    await withEnv({ ...SELF_HOSTED, APP_ORIGIN: undefined, APP_URL: PUBLIC, NEXT_PUBLIC_APP_URL: PUBLIC, VERCEL_PROJECT_PRODUCTION_URL: "particl.test" }, () => held(sent as never).notifyHeld({ id: "g1", needs: 10, left: 2 }));
  } finally { console.error = original; }
  expect(sent).toHaveLength(0);
  expect(lines.filter((l) => /APP_ORIGIN is not set/.test(l))).toHaveLength(2);
});

test("backgroundMailOrigin: APP_ORIGIN; on Vercel without it the production domain; otherwise none", () => {
  const { backgroundMailOrigin } = site;
  expect(backgroundMailOrigin({ ...SELF_HOSTED, APP_ORIGIN: `${PUBLIC}/` })).toBe(PUBLIC);
  expect(backgroundMailOrigin({ VERCEL: "1", NODE_ENV: "production", APP_ORIGIN: PUBLIC, VERCEL_PROJECT_PRODUCTION_URL: "particl.test" })).toBe(PUBLIC);
  expect(backgroundMailOrigin({ VERCEL: "1", NODE_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "particl.test" })).toBe("https://particl.test");
  expect(backgroundMailOrigin({ VERCEL: "1", NODE_ENV: "production" })).toBeNull();
  expect(backgroundMailOrigin(SELF_HOSTED)).toBeNull();
  expect(backgroundMailOrigin({ ...SELF_HOSTED, VERCEL_PROJECT_PRODUCTION_URL: "particl.test" })).toBeNull();
  expect(backgroundMailOrigin({ ...SELF_HOSTED, APP_ORIGIN: "not a url" })).toBeNull();
  for (const NODE_ENV of ["development", "test", undefined]) expect(backgroundMailOrigin({ NODE_ENV })).toBeNull();
});
