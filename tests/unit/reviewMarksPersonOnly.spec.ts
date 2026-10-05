import { test, expect } from "@playwright/test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantToken, TenantWorkspace } from "../../lib/tenant";

/**
 * Judging a take is a person's call (design README § 4: Approve / Reject (take) · who: person): PATCH /api/jobs/:id
 * { reviewState } is refused for an API token, read or render, and still works for a signed-in person. Other edits a
 * token may already make are unchanged.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-review-person-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

const workspace: TenantWorkspace = {
  id: "review-person", name: "review-person", slug: "review-person", legacy: false,
  dbUrl: `file:${path.join(dir, "review-person.db")}`, dbToken: null,
  keys: {}, usesPlatformKeys: false, allowanceUsd: null,
  ownerId: "member", createdAt: 0, gatewayKeyId: null,
  suspendedAt: null, suspendedReason: null, flaggedAt: null,
  flagNote: null, concurrency: null, rendersPerHour: null,
  storageQuotaBytes: null, deletedAt: null,
};
const user = { id: "member", name: "Person One", email: "one@example.invalid", role: "member" };

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}

async function setup() {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const jobs = await import("../../lib/jobs");
  const { NextResponse } = createRequire(path.resolve("app/api/jobs/[id]/route.ts"))("next/server") as typeof import("next/server");
  await tenant.runInTenant(workspace, async () => {
    await database.ready();
    await database.db().execute(`INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title) VALUES('take-1','fixture','A prompt','{}','succeeded',100,100,'video','Take')`);
  });
  let caller: { token?: TenantToken } = {};
  const auth = {
    requireUser: async () => ({ user, ...(caller.token ? { token: caller.token } : {}) }),
    withTenant: (handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request, ctx: unknown) => tenant.runInTenant(workspace, () => handler(req, ctx)),
  };
  const route = load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    "@/lib/auth": auth, "@/lib/tenant": tenant, "@/lib/db": database, "@/lib/jobs": { getGeneration: jobs.getGeneration, syncGeneration: async (v: unknown) => v },
    "next/server": { NextResponse, after: (task: () => Promise<unknown>) => { void AsyncLocalStorage.bind(task); } },
    "@/lib/recovery": { reserveRecoveryContinuation: async (_n: string, task: () => Promise<unknown>) => task },
    "@/lib/push": { notify: async () => {} }, "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
    "@/lib/workbench/records": {}, "@/lib/mediaBindings": {}, "@/lib/mediaDeletion": {}, "@/lib/shots": {}, "@/lib/held": {},
    "@/lib/workbench/request-scope": await import("../../lib/workbench/request-scope"),
  });
  const patch = (body: unknown) => route.PATCH(new Request("https://studio.test/api/jobs/take-1", {
    method: "PATCH", headers: { "Content-Type": "application/json", "X-Workbench-Scope": `particl-active-${workspace.id}-${user.id}` }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "take-1" }) });
  const state = () => tenant.runInTenant(workspace, async () => String((await database.db().execute("SELECT review_state FROM generations WHERE id='take-1'")).rows[0].review_state));
  return { patch, state, as: (token?: TenantToken) => { caller = token ? { token } : {}; } };
}

test("an API token, read or render, can never approve, pick, send back or clear a take's review; a signed-in person can", async () => {
  const api = await setup();
  const read: TenantToken = { id: "t1", name: "Reader", scope: "read", capUsd: null };
  const render: TenantToken = { id: "t2", name: "Renderer", scope: "render", capUsd: 5 };

  for (const token of [read, render]) {
    api.as(token);
    for (const reviewState of ["approved", "picked", "changes", ""]) {
      const response = await api.patch({ reviewState });
      expect(response.status, `${token.scope} ${reviewState || "clear"}`).toBe(403);
      expect(((await response.json()) as { error: string }).error).toMatch(/signed-in person/);
    }
    expect(await api.state()).toBe("");
  }

  /* Other edits a token may already make are untouched by this rule. */
  api.as(render);
  expect((await api.patch({ title: "A name" })).status).toBe(200);

  api.as(undefined);
  expect((await api.patch({ reviewState: "approved" })).status).toBe(200);
  expect(await api.state()).toBe("approved");
  expect((await api.patch({ reviewState: "changes" })).status).toBe(200);
  expect(await api.state()).toBe("changes");
});
