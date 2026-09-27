import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

/* The admin desk's PATCH, with its dependencies replaced by recorders. */
function adminRoute(workspace: { deletedAt: number | null; legacy?: boolean }) {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/plans": { asPlanId: (v: unknown) => (v === "studio" ? v : null) },
    "@/lib/auth": {
      requireSuperAdmin: async () => ({ user: { id: "platform-owner" } }),
    },
    "@/lib/platform": {
      getWorkspace: async () => ({ id: "ws", legacy: false, ...workspace }),
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
    "@/lib/tenant": { runInTenant: async () => ({ released: [] }) },
    "@/lib/held": { releaseHeldJobs: async () => ({ released: [] }) },
    "@/lib/purge": { restoreDeletedWorkspace: record("restore") },
  };
  const compiled = ts.transpileModule(
    readFileSync("app/api/admin/workspaces/[id]/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const mod = {
    exports: {} as {
      PATCH: (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>;
    },
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in mocks))
        throw new Error("Unexpected route dependency " + name);
      return mocks[name];
    },
    mod,
    mod.exports,
  );
  return {
    calls,
    patch: (body: unknown) =>
      mod.exports.PATCH(
        new Request("http://localhost/api/admin/workspaces/ws", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: "ws" }) },
      ),
  };
}

test("a deleted workspace takes no credits, plan or limits from the desk; it can be marked, and restored", async () => {
  for (const body of [
    { grantCredits: 500 },
    { grantCredits: 500, note: "goodwill" },
    { planId: "studio" },
    { allowanceUsd: 20 },
    { mode: "platform" },
    { suspended: true, limits: { concurrency: 2 } },
    { limits: { concurrency: 2 } },
    { internalTest: true },
  ]) {
    const route = adminRoute({ deletedAt: 1 });
    const response = await route.patch(body);
    expect(response.status).toBe(409);
    expect(route.calls).toEqual([]);
  }
  // Suspending and flagging mark it for the desk before any restore.
  const marked = adminRoute({ deletedAt: 1 });
  expect((await marked.patch({ suspended: true, reason: "Abuse" })).status).toBe(200);
  expect((await marked.patch({ flagged: true, note: "Review" })).status).toBe(200);
  expect(marked.calls).toEqual(["suspended", "flag"]);
  const deleted = adminRoute({ deletedAt: 1 });
  const restored = await deleted.patch({ restore: true });
  expect(restored.status).toBe(200);
  expect(deleted.calls).toEqual(["restore"]);
  const live = adminRoute({ deletedAt: null });
  expect((await live.patch({ restore: true })).status).toBe(400);
  expect((await live.patch({ grantCredits: 5 })).status).toBe(200);
  expect(live.calls).toEqual(["grant"]);
});

test("the desk states the welcome grant from the same source provisioning uses, and no unwired gateway promise", () => {
  const route = readFileSync("app/api/admin/invites/route.ts", "utf8");
  expect(route).toContain("await approvedWelcomeCredits()");
  expect(route).not.toContain("signupCredits()");
  expect(route).toContain("deletedAt:");
  const page = readFileSync("app/(app)/admin/page.tsx", "utf8");
  expect(page).not.toContain("VERCEL_TOKEN");
  expect(page).toContain("0 from self-serve sign-up");
});
