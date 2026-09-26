import { test, expect } from "@playwright/test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * The review route behind the Takes desk: PATCH /api/jobs/:id { reviewState }
 * (app/api/jobs/[id]/route.ts). It records who picked, approved or sent a take
 * back, answers the marks it recorded, refuses a word it does not know, a take
 * that is gone or not finished, and a take in another workspace; a pick asks
 * this workspace's admins once, through the app's own notifications.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-takes-review-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

function workspace(id: string): TenantWorkspace {
  return {
    id, name: id, slug: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: false, allowanceUsd: null,
    ownerId: "member", createdAt: 0, gatewayKeyId: null,
    suspendedAt: null, suspendedReason: null, flaggedAt: null,
    flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}

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

async function seed(ws: TenantWorkspace) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(ws, async () => {
    await ready();
    const take = (id: string, status: string, deleted = 0) => ({
      sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title,deleted) VALUES(?,'fixture','A prompt','{}',?,100,100,'image',?,?)`,
      args: [id, status, `Take ${id}`, deleted],
    });
    const person = (id: string, role: string, disabled = 0) => ({
      sql: `INSERT INTO users(id,email,name,password_hash,role,disabled,created_at) VALUES(?,?,?,'!',?,?,0)`,
      args: [id, `${id}@example.invalid`, `Person ${id}`, role, disabled],
    });
    await db().batch([
      take("done", "succeeded"), take("again", "succeeded"), take("running", "running"), take("failed", "failed"), take("hidden", "succeeded", 1),
      person("member", "member"), person("admin-1", "admin"), person("admin-2", "admin"), person("admin-off", "admin", 1),
    ]);
  });
}

async function routes(initial: TenantWorkspace) {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const scope = await import("../../lib/workbench/request-scope");
  const jobs = await import("../../lib/jobs");
  /* The route's own NextResponse, required the way the route requires it. */
  const { NextResponse } = createRequire(path.resolve("app/api/jobs/[id]/route.ts"))("next/server") as typeof import("next/server");
  let selected = initial;
  const afters: (() => Promise<unknown>)[] = [];
  const notified: { kind: string; ids: string[]; payload: { title: string; body: string; url?: string } }[] = [];
  const auth = load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope,
    "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => ({ value: "fixture-session" }) }),
      headers: async () => new Headers(),
    },
    "./platform": {
      sessionLookup: async () => ({
        account: { id: "member", name: "Studio member", email: "member@example.invalid", mfa_enabled: 1 },
        workspaceId: selected.id,
      }),
      workspacesFor: async () => [{ workspace: selected, role: "member" }],
    },
  });
  const route = load<typeof import("../../app/api/jobs/[id]/route")>("app/api/jobs/[id]/route.ts", {
    "@/lib/auth": auth, "@/lib/tenant": tenant, "@/lib/db": database,
    "@/lib/workbench/request-scope": scope,
    "@/lib/jobs": { getGeneration: jobs.getGeneration, syncGeneration: async (value: unknown) => value },
    /* Next runs an `after` task in the request's own context (its workspace), once the response is sent. */
    "next/server": { NextResponse, after: (task: () => Promise<unknown>) => { afters.push(AsyncLocalStorage.bind(task)); } },
    "@/lib/recovery": { reserveRecoveryContinuation: async (_name: string, task: () => Promise<unknown>) => task },
    "@/lib/push": { notify: async (kind: string, ids: string[], payload: { title: string; body: string; url?: string }) => { notified.push({ kind, ids: [...ids].sort(), payload }); } },
    "@/lib/cache": { invalidate: () => {}, PROJECTS_KEY: "projects" },
    "@/lib/workbench/records": {}, "@/lib/mediaBindings": {}, "@/lib/mediaDeletion": {}, "@/lib/shots": {}, "@/lib/held": {},
  });
  const patch = (id: string, body: unknown, headers: Record<string, string> = { "X-Workbench-Scope": `particl-active-${selected.id}-member` }) =>
    route.PATCH(new Request(`https://studio.test/api/jobs/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  const row = async (ws: TenantWorkspace, id: string) => {
    const { runInTenant } = await import("../../lib/tenant");
    const { db } = await import("../../lib/db");
    return runInTenant(ws, async () => (await db().execute({ sql: "SELECT review_state, review_by, picked_by, approved_by FROM generations WHERE id=?", args: [id] })).rows[0]);
  };
  return { patch, row, afters, notified, switch: (ws: TenantWorkspace) => { selected = ws; } };
}

test("a review records who, answers the marks, and a pick asks this workspace's admins once", async () => {
  const ws = workspace("review-marks");
  await seed(ws);
  const api = await routes(ws);

  const picked = await api.patch("done", { reviewState: "picked" });
  expect(picked.status).toBe(200);
  const body = await picked.json();
  expect(body).toMatchObject({ ok: true, review: { reviewState: "picked", reviewBy: "Studio member", pickedBy: "Studio member", approvedBy: null } });
  expect(typeof body.review.pickedAt).toBe("number");
  expect(typeof body.review.updatedAt).toBe("number");
  /* The admins who can be asked: this workspace's, enabled, not the person who picked. */
  expect(api.afters).toHaveLength(1);
  await api.afters[0]();
  expect(api.notified).toEqual([{ kind: "approvalNeeded", ids: ["admin-1", "admin-2"], payload: { title: "A take is waiting on you", body: "Studio member picked it.", url: "/" } }]);
  /* Picked again (another tab): nobody is asked twice. */
  expect((await api.patch("done", { reviewState: "picked" })).status).toBe(200);
  expect(api.afters).toHaveLength(1);

  /* Approving keeps who picked it; sending it back keeps both marks; clearing takes it back to review. */
  expect((await (await api.patch("done", { reviewState: "approved" })).json()).review).toMatchObject({ reviewState: "approved", pickedBy: "Studio member", approvedBy: "Studio member" });
  expect((await (await api.patch("done", { reviewState: "changes" })).json()).review).toMatchObject({ reviewState: "changes", reviewBy: "Studio member", pickedBy: "Studio member", approvedBy: "Studio member" });
  expect((await (await api.patch("done", { reviewState: "" })).json()).review).toMatchObject({ reviewState: "", reviewBy: null });
  expect(api.afters).toHaveLength(1);
  /* Picked after it was cleared: a new decision is asked for. */
  await api.patch("done", { reviewState: "picked" });
  expect(api.afters).toHaveLength(2);
});

test("a review is refused for a word it does not know, a take that is gone or not finished, and without the page's scope", async () => {
  const ws = workspace("review-refusals");
  await seed(ws);
  const api = await routes(ws);
  await api.patch("again", { reviewState: "approved" });

  /* An unknown word no longer clears a sign-off. */
  const unknown = await api.patch("again", { reviewState: "draft" });
  expect(unknown.status).toBe(400);
  expect((await unknown.json()).error).toBe("A review is picked, approved or changes, or empty to clear it.");
  expect(await api.row(ws, "again")).toMatchObject({ review_state: "approved" });
  /* A hidden take, or one that never existed. */
  for (const id of ["hidden", "nope"]) {
    const gone = await api.patch(id, { reviewState: "picked" });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe("This take is no longer in the project.");
  }
  expect(await api.row(ws, "hidden")).toMatchObject({ review_state: "" });
  /* Nothing to judge yet; clearing is always allowed. */
  for (const id of ["running", "failed"]) {
    const early = await api.patch(id, { reviewState: "approved" });
    expect(early.status).toBe(409);
    expect((await early.json()).error).toBe("Only a finished take can be picked, approved or sent back.");
    expect((await api.patch(id, { reviewState: "" })).status).toBe(200);
  }
  /* A page captured for another workspace, or no scope at all, writes nothing. */
  for (const headers of [{}, { "X-Workbench-Scope": "particl-active-elsewhere-member" }]) {
    expect((await api.patch("again", { reviewState: "changes" }, headers)).status).toBe(409);
  }
  expect(await api.row(ws, "again")).toMatchObject({ review_state: "approved" });
  expect(api.notified).toEqual([]);
});

test("a take in another workspace cannot be reviewed from this one", async () => {
  const first = workspace("review-first"), second = workspace("review-second");
  await seed(first);
  await seed(second);
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(first, async () => { await db().execute("INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at,kind,title) VALUES('only-first','fixture','','{}','succeeded',1,1,'image','Only first')"); });
  const api = await routes(second);
  const other = await api.patch("only-first", { reviewState: "approved" });
  expect(other.status).toBe(404);
  expect(await api.row(first, "only-first")).toMatchObject({ review_state: "", approved_by: null });
  /* The same id in each workspace is each workspace's own. */
  expect((await api.patch("done", { reviewState: "approved" })).status).toBe(200);
  expect(await api.row(second, "done")).toMatchObject({ review_state: "approved" });
  expect(await api.row(first, "done")).toMatchObject({ review_state: "" });
});
