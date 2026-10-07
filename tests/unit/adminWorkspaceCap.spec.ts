import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { CAP_MAX_USD, capCredits, capLabel, capView, parseCapUsd } from "../../lib/allowanceDesk";

/* The engine cap on /admin's workspace row (lib/allowanceDesk.ts) and the admin route it saves through.
   A local temporary platform database only; nothing here reaches a server. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-admin-cap-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.WORKSPACE_DB_DIRECTORY = path.join(dir, "tenants");
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
process.env.SUPER_ADMIN_EMAIL = "desk-owner@example.test";
delete process.env.TURSO_API_TOKEN;
delete process.env.TURSO_ORG;

test("the desk converts the cap at the server's credit price, to a tenth, with no float noise", () => {
  expect(capCredits(0, 0.1)).toBe(0);
  expect(capCredits(21.8, 0.1)).toBe(218);
  expect(capCredits(0.3, 0.1)).toBe(3);
  expect(capCredits(25.05, 0.1)).toBe(250.5);
  // Another credit price is read, never assumed.
  expect(capCredits(10, 0.125)).toBe(80);
  expect(capCredits(CAP_MAX_USD, 0.1)).toBe(1_000_000);
});

test("what an admin types: dollars to the cent, $0 kept as 0, blank never read as 0 or as no cap", () => {
  expect(parseCapUsd("0")).toEqual({ ok: true, usd: 0 });
  expect(parseCapUsd("0.00")).toEqual({ ok: true, usd: 0 });
  expect(parseCapUsd("$21.80")).toEqual({ ok: true, usd: 21.8 });
  expect(parseCapUsd(" 1,250 ")).toEqual({ ok: true, usd: 1250 });
  expect(parseCapUsd(String(CAP_MAX_USD))).toEqual({ ok: true, usd: CAP_MAX_USD });
  for (const blank of ["", "   ", "$"]) expect(parseCapUsd(blank)).toEqual({ ok: false, error: "Type dollars a month, 0 or more." });
  for (const bad of ["-1", "abc", "1.234", "1e3", "Infinity", "0x10", "2..5"])
    expect(parseCapUsd(bad), bad).toEqual({ ok: false, error: "Dollars a month, 0 or more, to the cent." });
  expect(parseCapUsd(String(CAP_MAX_USD + 1))).toEqual({ ok: false, error: "At most $100,000 a month." });
});

test("the cell tells its own cap, $0 as a wall, from the deployment's default and from no cap at all", () => {
  const own0 = capView({ allowanceUsd: 0 }, null, 0.1);
  expect(own0).toEqual({ kind: "own", usd: 0, credits: 0 });
  expect(capLabel(own0, 0.1)).toMatchObject({ main: "$0.00 · 0 CR", sub: "Nothing can spend" });
  // An own $0 wins over a deployment default: 0 is a cap, not a missing one.
  expect(capView({ allowanceUsd: 0 }, 50, 0.1)).toEqual({ kind: "own", usd: 0, credits: 0 });
  const own = capView({ allowanceUsd: 21.8 }, null, 0.1);
  expect(capLabel(own, 0.1)).toMatchObject({ main: "$21.80 · 218 CR", sub: "Engine cost a month" });
  expect(capLabel(capView({ allowanceUsd: 1250 }, null, 0.1), 0.1).main).toBe("$1,250.00 · 12,500 CR");
  const fallback = capView({ allowanceUsd: null }, 50, 0.1);
  expect(fallback).toEqual({ kind: "default", usd: 50, credits: 500 });
  expect(capLabel(fallback, 0.1)).toMatchObject({ main: "$50.00 · 500 CR", sub: "Deployment default" });
  expect(capLabel(capView({ allowanceUsd: null }, 0, 0.1), 0.1).sub).toBe("Default · nothing can spend");
  expect(capLabel(capView({ allowanceUsd: null }, null, 0.1), 0.1)).toMatchObject({ main: "NO CAP", sub: "Deployment sets none" });
  // The house is never billed in credits and takes no cap, whatever its row holds.
  expect(capView({ allowanceUsd: 5, house: true }, 50, 0.1)).toEqual({ kind: "house" });
  // Every label says what it caps: the engines' charge to the platform, not the credits billed.
  const title = capLabel(own, 0.1).title;
  expect(title).toContain("what the engines charge the platform");
  expect(title).toContain("not a cap on the credits the workspace is billed");
  expect(title).toContain("$0.10 each");
});

/* What the stored value does today. These read the enforcement as it stands; this change adds none. */
test("an own $0 cap is a wall, never 'no cap': it outranks the deployment default, and a quote at $0 is refused", async () => {
  const { allowanceUsd } = await import("../../lib/allowance");
  const { runInTenant } = await import("../../lib/tenant");
  const { verdictOf } = await import("../../lib/quote");
  const at = (cap: number | null) => ({ id: "ws_cap", slug: "cap", name: "Cap", legacy: false, dbUrl: "file::memory:", dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: cap, gatewayKeyId: null }) as never;
  const before = process.env.PLATFORM_ALLOWANCE_USD;
  try {
    process.env.PLATFORM_ALLOWANCE_USD = "50";
    expect(await runInTenant(at(0), async () => allowanceUsd())).toBe(0);
    expect(await runInTenant(at(null), async () => allowanceUsd())).toBe(50);
    delete process.env.PLATFORM_ALLOWANCE_USD;
    expect(await runInTenant(at(null), async () => allowanceUsd())).toBeNull();
    expect(await runInTenant(at(0), async () => allowanceUsd())).toBe(0);
  } finally {
    if (before == null) delete process.env.PLATFORM_ALLOWANCE_USD; else process.env.PLATFORM_ALLOWANCE_USD = before;
  }
  const quote = { totalCredits: 2, unitCredits: 2, units: 1, usd: 0.1, lines: [{ key: "k", credits: 2, count: 1, usd: 0.1, spent: 0, code: "S1", projectId: null, platformPays: true }] };
  const context = { balance: 1000, caps: {}, warnPct: 80, rule: "anyone" as const, shotCap: 0, isAdmin: true };
  expect(verdictOf(quote, { ...context, allowance: { cap: 0, spent: 0 } })).toMatchObject({ allow: false, gate: "allowance" });
  expect(verdictOf(quote, { ...context, allowance: null })).toMatchObject({ allow: true });
  // The admission and reservation walls compare against the cap itself, never its truthiness.
  const allowance = readFileSync("lib/allowance.ts", "utf8");
  expect(allowance).toContain("if (cap == null) return { ok: true };");
  /* A take that holds its ceiling (Cinema Studio) counts at its band; every other job at 1. */
  expect(allowance).toContain("if (spent >= cap || spent + Math.max(0, estUsd) * (Number.isInteger(band) && band > 1 ? band : 1) > cap)");
  expect(allowance).toContain("return ws.allowanceUsd ?? defaultAllowanceUsd();");
  expect(readFileSync("lib/generationRequests.ts", "utf8")).toContain("if (monthlyCap != null && ");
});

/* The admin route with its real guard (lib/auth.ts requireSuperAdmin) and recorders for every write. */
async function adminRoute() {
  const auth = await import("../../lib/auth");
  const tenant = await import("../../lib/tenant");
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push({ name, args }); };
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/plans": { asPlanId: () => null },
    "@/lib/auth": auth,
    "@/lib/platform": {
      getWorkspace: async () => ({ id: "ws_desk", legacy: false, deletedAt: null }),
      platformKeysByDefault: () => true,
      setWorkspaceInternalTest: record("internalTest"),
      setWorkspaceAllowance: record("allowance"),
      setWorkspaceMode: record("mode"),
      grantCredits: record("grant"),
      setWorkspaceSuspended: record("suspended"),
      setWorkspaceFlag: record("flag"),
      setWorkspaceLimits: record("limits"),
      setWorkspacePlan: record("plan"),
    },
    "@/lib/tenant": tenant,
    "@/lib/held": { releaseHeldJobs: async () => ({ released: [] }) },
    "@/lib/purge": { restoreDeletedWorkspace: record("restore") },
    "@/lib/houseWorkspace": await import("../../lib/houseWorkspace"),
  };
  const compiled = ts.transpileModule(readFileSync("app/api/admin/workspaces/[id]/route.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as { PATCH: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in mocks)) throw new Error("Unexpected route dependency " + name);
    return mocks[name];
  }, mod, mod.exports);
  const ws = { id: "ws_desk", slug: "desk", name: "Desk", legacy: false, dbUrl: "file::memory:", dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null };
  const user = (email: string) => ({ id: `acct_${email.split("@")[0]}`, email, name: "Desk", role: "admin" as const, owner: true, disabled: false, lastSeen: null, createdAt: 0 });
  const patch = (body: unknown, extra: Record<string, unknown>) =>
    tenant.runInTenant(ws as never, () => mod.exports.PATCH(
      new Request("http://localhost/api/admin/workspaces/ws_desk", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: "ws_desk" }) },
    ), extra as never);
  return { calls, patch, user };
}

test("the cap saves only for the platform owner in a browser session: tokens and other admins are refused before any write", async () => {
  const route = await adminRoute();
  const deskOwner = route.user("desk-owner@example.test");
  // The platform owner's own API tokens, either scope: refused, nothing written.
  for (const scope of ["read", "render"] as const) {
    const res = await route.patch({ allowanceUsd: 0 }, { user: deskOwner, token: { id: "t", name: "Token", scope, capUsd: null } });
    expect(res.status, scope).toBe(403);
    expect((await res.json()).error).toContain("signed-in browser session");
  }
  // A workspace admin and owner who is not the platform's owner: refused.
  const other = await route.patch({ allowanceUsd: 0 }, { user: route.user("workspace-admin@example.test") });
  expect(other.status).toBe(403);
  expect((await other.json()).error).toBe("The platform owner only.");
  expect(route.calls).toEqual([]);

  // The platform owner: $0 is stored as 0, a figure as itself, blank or null returns to the default.
  for (const [body, stored] of [[0, 0], ["0", 0], [21.8, 21.8], [null, null], ["", null]] as const) {
    const res = await route.patch({ allowanceUsd: body }, { user: deskOwner });
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((await res.json()).allowanceUsd).toBe(stored);
    expect(route.calls.pop()).toEqual({ name: "allowance", args: ["ws_desk", stored] });
  }
  // Out of range or not a number: refused, nothing written.
  for (const body of [-1, "abc", 100_001]) {
    const res = await route.patch({ allowanceUsd: body }, { user: deskOwner });
    expect(res.status, JSON.stringify(body)).toBe(400);
  }
  expect(route.calls).toEqual([]);
});

test("the desk's cap field sends only the allowance, through the existing admin route", () => {
  const page = readFileSync("app/(app)/admin/page.tsx", "utf8");
  const cell = page.slice(page.indexOf("function CapCell("), page.indexOf("type Queue = {"));
  expect(cell).toContain("`/api/admin/workspaces/${encodeURIComponent(w.id)}`");
  expect(cell).toContain('method: "PATCH"');
  expect(cell).toContain("JSON.stringify({ allowanceUsd: usd })");
  expect(cell).toContain("parseCapUsd(val)");
  // Removing the cap is its own confirmed act, never an empty box.
  expect(cell).toContain('appConfirm("Remove this workspace\'s own cap?"');
  expect(cell).toContain("save(null)");
});
