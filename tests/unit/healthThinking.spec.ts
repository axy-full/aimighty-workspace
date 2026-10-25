import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HIGH, LOW, MEDIUM, withSlotEnv } from "../helpers/thinkingSlots";
import { thinkingModelNames } from "../helpers/uiStrings";
import { loadRouteModule } from "../helpers/vendorCostScan";
import * as atRiskWindow from "../../lib/atRiskWindow";
import type { CatalogModel } from "../../lib/catalog";
import { THINKING_EFFORTS, THINKING_SETTINGS, thinkingEffortEnv, thinkingModelEnv } from "../../lib/atomikModelPolicy";

/**
 * /api/health, owner's decision of 24 Oct 2026: the platform owner's briefing says whether Atomik's Thinking is served on each setting,
 * by name only ("Thinking: High · Medium · Low served", or which are "not set" or "not served"), never a model id, an effort or a rate.
 * A member and an anonymous caller still get exactly { ok, commit }. The slots are tests/helpers/thinkingSlots.ts's, picked from the
 * checked-in catalogue at run time and never written down; the catalogue is the checked-in snapshot (MODEL_CATALOG=static) under the
 * mocked engines (ENGINE_MOCK=1). The owner gate (lib/auth.ts isPlatformOwner) and the Thinking read (lib/atomikThinking.ts) are the
 * real ones; the deployment's other collaborators are stood in. Nothing is sent or spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-health-thinking-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const OWNER = { id: "u_owner", email: "owner-thinking@example.test" }, MEMBER = { id: "u_member", email: "member-thinking@example.test" };
const NAMES = ["High", "Medium", "Low"];
/* Each slot thinks at a distinct named effort here, so an effort that leaked would be found. */
const EFFORTS: Record<string, string> = { high: "xhigh", medium: "max", low: "minimal" };
let before: Record<string, string | undefined> = {};
const KEYS = ["SUPER_ADMIN_EMAIL", "ENGINE_MOCK", "MODEL_CATALOG", ...THINKING_SETTINGS.map(thinkingEffortEnv)];
test.beforeEach(() => {
  before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.SUPER_ADMIN_EMAIL = OWNER.email;
  process.env.ENGINE_MOCK = "1";
  process.env.MODEL_CATALOG = "static";
  for (const setting of THINKING_SETTINGS) process.env[thinkingEffortEnv(setting)] = EFFORTS[setting];
});
test.afterEach(() => { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });

type Who = "anonymous" | "member" | "owner";
/** The health route, run as `who`; `without` drops those ids from the catalogue a turn would read. */
async function health(who: Who, without: readonly string[] = []) {
  const auth = await import("../../lib/auth");
  const thinking = await import("../../lib/atomikThinking");
  const { catalog } = await import("../../lib/catalog");
  const user = who === "owner" ? OWNER : who === "member" ? MEMBER : null;
  const ctx = user ? { user, workspace: { id: "ws_client", name: "A client's studio" } } : null;
  const database = { execute: async () => ({ rows: [{ saved: 0, atrisk: 0 }] }) };
  const { GET } = loadRouteModule<{ GET: (req: Request) => Promise<Response> }>("app/api/health/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/providers": { PROVIDERS: [], providerConfigured: () => true, providerVia: () => "key" },
    "@/lib/auth": { currentContext: async () => ctx, isPlatformOwner: auth.isPlatformOwner, requireSuperAdmin: async () => ({ response: Response.json({ error: "Forbidden" }, { status: 403 }) }) },
    "@/lib/tenant": { runInTenant: async (_ws: unknown, fn: () => unknown) => fn() },
    "@/lib/platform": { platformReady: async () => undefined, platformDb: () => database },
    "@/lib/db": { ready: async () => undefined, db: () => database },
    "@/lib/vendorKeys": { vendorKey: () => null },
    "@/lib/settings": { allSettings: async () => ({}) },
    "@/lib/storage/backend": { backendKind: () => "local", cloudBackend: () => { throw new Error("not probed"); } },
    "@/lib/mail": { mailConfigured: () => false, mailFrom: () => null },
    "@/lib/mock": { engineMock: () => false },
    "@/lib/dispatch": { dispatchMode: () => "native" },
    "@/lib/dispatch-log": { recentDispatches: async () => [] },
    "@/lib/atRiskWindow": atRiskWindow,
    "@/lib/deployment": { deployedCommit: () => "0123456789abcdef0123456789abcdef01234567" },
    "@/lib/vercelGuard": { vercelIdentityInProduction: () => [] },
    /* The real Thinking read; a case that takes models out of the catalogue hands it what is left. */
    "@/lib/atomikThinking": without.length
      ? { ...thinking, thinkingHealth: async () => thinking.thinkingHealth((await catalog()).filter((m: CatalogModel) => !without.includes(m.id))) }
      : thinking,
  });
  const res = await GET(new Request("https://example.test/api/health"));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

/** Every key named `effort`, at any depth. */
const effortKeys = (value: unknown): string[] => !value || typeof value !== "object" ? []
  : Array.isArray(value) ? value.flatMap(effortKeys)
  : Object.entries(value).flatMap(([key, item]) => [...(key === "effort" ? [key] : []), ...effortKeys(item)]);
/** Nothing in the body names a configured id, an effort (as a word or a key) or a thinking model. */
function expectNoDisclosure(text: string) {
  for (const id of [HIGH, MEDIUM, LOW]) expect(text).not.toContain(id);
  for (const effort of THINKING_EFFORTS) expect(text, effort).not.toMatch(new RegExp(`\\b${effort}\\b`));
  expect(effortKeys(JSON.parse(text))).toEqual([]);
  expect(thinkingModelNames(text)).toEqual([]);
}

test("the platform owner sees each Thinking setting by name, all served, and no id, effort or rate", async () => {
  const { status, text, body } = await health("owner");
  expect(status).toBe(200);
  expect(body.thinking).toEqual({ line: "Thinking: High · Medium · Low served", settings: NAMES.map((name) => ({ name, state: "served" })) });
  expectNoDisclosure(text);
  expect(text).not.toMatch(/pricing|input_cache|"rates?"/i);
});

test("a slot that is not set reads 'not set', and the others are named in turn", async () => {
  const { text, body } = await withSlotEnv({ [thinkingModelEnv("high")]: undefined }, () => health("owner"));
  expect(body.thinking).toEqual({
    line: "Thinking: High not set · Medium served · Low served",
    settings: [{ name: "High", state: "not set" }, { name: "Medium", state: "served" }, { name: "Low", state: "served" }],
  });
  expectNoDisclosure(text);
  /* A value that is not a verified Claude id is not set either. */
  const other = await withSlotEnv({ [thinkingModelEnv("medium")]: "not-a-verified-model" }, () => health("owner"));
  expect((other.body.thinking as { line: string }).line).toBe("Thinking: High served · Medium not set · Low served");
  expect(other.text).not.toContain("not-a-verified-model");
});

test("served means what a turn gets: a cheaper fallback serves High; Low with nothing to run it is 'not served'", async () => {
  /* High's own model off the catalogue: a turn at High runs a cheaper slot's model (selectAtomikThinking), so High is served. */
  const fallback = await health("owner", [HIGH]);
  expect((fallback.body.thinking as { line: string }).line).toBe("Thinking: High · Medium · Low served");
  expectNoDisclosure(fallback.text);
  /* Low's own model off the catalogue: nothing cheaper may stand in, so a turn at Low is refused, and the briefing says so. */
  const low = await health("owner", [LOW]);
  expect(low.body.thinking).toEqual({
    line: "Thinking: High served · Medium served · Low not served",
    settings: [{ name: "High", state: "served" }, { name: "Medium", state: "served" }, { name: "Low", state: "not served" }],
  });
  expectNoDisclosure(low.text);
  const none = await health("owner", [HIGH, MEDIUM, LOW]);
  expect((none.body.thinking as { line: string }).line).toBe("Thinking: High · Medium · Low not served");
  expectNoDisclosure(none.text);
});

test("a member and an anonymous caller get only ok and the commit: no Thinking line", async () => {
  for (const who of ["member", "anonymous"] as const) {
    const { status, text, body } = await health(who);
    expect(status, who).toBe(200);
    expect(body, who).toEqual({ ok: true, commit: "0123456" });
    expect(text, who).not.toMatch(/thinking|served|not set/i);
    expectNoDisclosure(text);
  }
});
