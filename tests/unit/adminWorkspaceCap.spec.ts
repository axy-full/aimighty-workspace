import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { CAP_MAX_USD, capLabel, capView, parseCapUsd } from "../../lib/allowanceDesk";

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

test("the desk shows the cap in engine dollars only: never a figure in credits that would read as a cap on billed credits", () => {
  /* Billing adds each engine's margin and rounds each job up, so engine dollars divided by the credit price
     under-states what the workspace may be billed; the desk shows no such figure (lib/allowanceDesk.ts). */
  const source = readFileSync("lib/allowanceDesk.ts", "utf8");
  expect(source).not.toMatch(/creditUsd|capCredits/);
  for (const v of [capView({ allowanceUsd: 10 }, null), capView({ allowanceUsd: null }, 10), capView({ allowanceUsd: 0 }, null)])
    expect(JSON.stringify(capLabel(v))).not.toMatch(/\bCR\b|credits shown/i);
  const page = readFileSync("app/(app)/admin/page.tsx", "utf8");
  const cell = page.slice(page.indexOf("function CapCell("), page.indexOf("type Queue = {"));
  expect(cell).not.toMatch(/creditUsd| CR\b/);
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
  const own0 = capView({ allowanceUsd: 0 }, null);
  expect(own0).toEqual({ kind: "own", usd: 0 });
  expect(capLabel(own0)).toMatchObject({ main: "$0.00", sub: "Nothing can spend" });
  // An own $0 wins over a deployment default: 0 is a cap, not a missing one.
  expect(capView({ allowanceUsd: 0 }, 50)).toEqual({ kind: "own", usd: 0 });
  const own = capView({ allowanceUsd: 21.8 }, null);
  expect(capLabel(own)).toMatchObject({ main: "$21.80", sub: "Engine cost a month" });
  expect(capLabel(capView({ allowanceUsd: 1250 }, null)).main).toBe("$1,250.00");
  const fallback = capView({ allowanceUsd: null }, 50);
  expect(fallback).toEqual({ kind: "default", usd: 50 });
  expect(capLabel(fallback)).toMatchObject({ main: "$50.00", sub: "Deployment default · engine cost" });
  expect(capLabel(capView({ allowanceUsd: null }, 0)).sub).toBe("Default · nothing can spend");
  expect(capLabel(capView({ allowanceUsd: null }, null))).toMatchObject({ main: "NO CAP", sub: "Deployment sets none" });
  // The house is never billed in credits and takes no cap, whatever its row holds.
  expect(capView({ allowanceUsd: 5, house: true }, 50)).toEqual({ kind: "house" });
  // Every label says what it caps: the engines' charge to the platform, not the credits billed.
  const title = capLabel(own).title;
  expect(title).toContain("what the engines charge the platform");
  expect(title).toContain("not a cap on the credits the workspace is billed");
  expect(title).toContain("its credit balance is that wall");
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
  const walled = verdictOf(quote, { ...context, allowance: { cap: 0, spent: 0 } });
  expect(walled).toMatchObject({ allow: false, gate: "allowance" });
  /* The quote says what the wall says: only the platform raises this cap, never "an admin can raise it". */
  const { ALLOWANCE_REACHED } = await import("../../lib/allowance");
  expect(walled.line).toBe(ALLOWANCE_REACHED);
  expect(verdictOf(quote, { ...context, allowance: null })).toMatchObject({ allow: true });
  // The admission and reservation walls compare against the cap itself, never its truthiness.
  const allowance = readFileSync("lib/allowance.ts", "utf8");
  expect(allowance).toContain("if (cap == null) return { ok: true };");
  /* A take that holds its ceiling (Cinema Studio) counts at its band; every other job at 1. */
  expect(allowance).toContain("if (spent >= cap || spent + Math.max(0, estUsd) * (Number.isInteger(band) && band > 1 ? band : 1) > cap)");
  expect(allowance).toContain("return ws.allowanceUsd ?? defaultAllowanceUsd();");
  /* The reservation reads the cap afresh inside its write (a cap lowered a moment ago applies), and compares against it. */
  const reservation = readFileSync("lib/generationRequests.ts", "utf8");
  expect(reservation).toContain("SELECT deleted_at,suspended_at,allowance_usd FROM workspaces WHERE id=?");
  expect(reservation).toContain("if (capNow != null && ");
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
    "@/lib/allowanceDesk": await import("../../lib/allowanceDesk"),
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

  // The platform owner: $0 is stored as 0, a figure as itself to the cent, and only a literal null returns to the default.
  for (const [body, stored] of [[0, 0], [21.8, 21.8], [0.1 + 0.2, 0.3], [100_000, 100_000], [null, null]] as const) {
    const res = await route.patch({ allowanceUsd: body }, { user: deskOwner });
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((await res.json()).allowanceUsd).toBe(stored);
    expect(route.calls.pop()).toEqual({ name: "allowance", args: ["ws_desk", stored] });
  }
  // Out of range, not a number, a string, a blank or anything else: refused, nothing written (never read as 0 or as no cap).
  for (const body of [-1, "abc", 100_001, "0", "", "21.80", true, false, [], {}]) {
    const res = await route.patch({ allowanceUsd: body }, { user: deskOwner });
    expect(res.status, JSON.stringify(body)).toBe(400);
  }
  // A bad figure beside other levers changes none of them: the cap is read before anything is written.
  const mixed = await route.patch({ suspended: true, flagged: true, allowanceUsd: "0" }, { user: deskOwner });
  expect(mixed.status).toBe(400);
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
