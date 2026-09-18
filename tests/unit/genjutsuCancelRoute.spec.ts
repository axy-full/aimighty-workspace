import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantStore, TenantUser } from "../../lib/tenant";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";

const directory = mkdtempSync(path.join(tmpdir(), "particl-genjutsu-cancel-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-genjutsu-cancel-keyring-secret";
process.env.ENGINE_MOCK = "1";
const creator: TenantUser = { id: "creator", email: "creator@example.invalid", name: "Creator", role: "member", owner: false, disabled: false, createdAt: 0, lastSeen: null };

/** Real tenant databases, generation lookup, withTenant and requireRender.
 * Only session resolution and the provider cancellation helper are isolated. */
async function fixture(name: string) {
  const auth = await import("../../lib/auth");
  const tenant = await import("../../lib/tenant");
  const jobs = await import("../../lib/jobs");
  const database = await import("../../lib/db");
  const { platformReady, platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { MediaSourceError } = await import("../../lib/mediaBindings");
  const scope = await import("../../lib/workbench/request-scope");
  const higgsfield = await import("../../lib/higgsfield");
  await platformReady();
  const stores: TenantStore[] = [];
  for (const suffix of ["a", "b"]) {
    const id = `${name}_${suffix}`;
    await platformDb().execute({ sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,'admin',0,0)", args: [id, id, id, `file:${path.join(directory, `${id}.db`)}`] });
    const workspace = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
    const store = { workspace, user: creator };
    stores.push(store);
    await tenant.runWithStore(store, async () => {
      await database.ready();
      await database.db().execute({ sql: "INSERT INTO generations(id,kind,model,provider,prompt,params,status,cost_usd,created_by,created_at,updated_at) VALUES(?,'video',?,'higgsfield','Original','{}','queued',0.75,'creator',0,0)", args: [suffix === "a" ? "own-take" : "foreign-take", GENJUTSU_MODELS["motion-transfer"]] });
    });
  }
  let store = stores[0];
  const source = ts.createSourceFile("auth.ts", readFileSync("lib/auth.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const statement = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "withTenant")!;
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const wrapper = {} as Pick<typeof auth, "withTenant">;
  new Function("exports", "resolveStore", "runWithStore", "NoTenantError", "MediaSourceError", "workbenchScopeFor", "recoveryRoute", compile(statement.getText(source)))(
    wrapper, async () => store, tenant.runWithStore, tenant.NoTenantError, MediaSourceError, scope.workbenchScopeFor, (handler: unknown) => handler,
  );
  const calls: { id: string; workspaceId: string; userId: string; tokenScope?: string }[] = [];
  let result: { status: string } = { status: "requested" }, failure: unknown;
  const deps: Record<string, unknown> = {
    "@/lib/auth": { ...auth, withTenant: wrapper.withTenant },
    "@/lib/tenant": tenant,
    "@/lib/jobs": jobs,
    "@/lib/higgsfield": higgsfield,
    "@/lib/workbench/request-scope": scope,
    "@/lib/genjutsuVideo": { cancelGenjutsuVideo: async (id: string) => {
      const current = tenant.currentTenant()!;
      calls.push({ id, workspaceId: current.workspace!.id, userId: current.user!.id, tokenScope: current.token?.scope });
      if (failure) throw failure;
      return result;
    } },
  };
  const output = { exports: {} as { POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> } };
  new Function("require", "module", "exports", compile(readFileSync("app/api/generations/[id]/cancel/route.ts", "utf8")))(
    (name: string) => { if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`); return deps[name]; }, output, output.exports,
  );
  return {
    stores, calls, store: () => store, setStore: (next: TenantStore) => { store = next; },
    result: (status: string) => { result = { status }; }, fail: (error: unknown) => { failure = error; },
    snapshot: () => tenant.runWithStore(stores[0], async () => (await database.db().execute("SELECT status,cost_usd,params,deleted FROM generations WHERE id='own-take'")).rows[0]),
    remove: () => tenant.runWithStore(stores[0], async () => { await database.db().execute("UPDATE generations SET deleted=1 WHERE id='own-take'"); }),
    post: async (id = "own-take", options: { scope?: string | null; origin?: string } = {}) => {
      const captured = options.scope === undefined && store.workspace && store.user ? scope.workbenchScopeFor(store.workspace.id, store.user.id) : options.scope;
      const request = new Request(`https://particl.example/api/generations/${encodeURIComponent(id)}/cancel`, {
        method: "POST", headers: { ...(captured == null ? {} : { "X-Workbench-Scope": captured }), ...(options.origin ? { Origin: options.origin } : {}) },
        // Neither a supplied creator nor tenant can override the captured session.
        body: JSON.stringify({ workspaceId: stores[1].workspace!.id, userId: "admin", refund: true }),
      });
      const prior = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error("Network forbidden in cancellation route tests."); };
      try { return await output.exports.POST(request, { params: Promise.resolve({ id }) }); }
      finally { globalThis.fetch = prior; }
    },
  };
}

test("Genjutsu cancellation rejects signed-out, read-only tokens and unavailable sessions before helper access", async () => {
  const f = await fixture("cancel_auth"), original = f.store();
  for (const [store, status] of [
    [{ ...original, user: null }, 401],
    [{ ...original, workspace: null }, 401],
    [{ ...original, workspace: { ...original.workspace!, deletedAt: 1 } }, 401],
    [{ ...original, workspace: { ...original.workspace!, suspendedAt: 1 } }, 423],
    [{ ...original, mfaRequired: true }, 428],
    [{ ...original, token: { id: "read", name: "Read", scope: "read", capUsd: null } }, 403],
  ] as const) {
    f.setStore(store);
    expect((await f.post("own-take", { scope: null })).status).toBe(status);
  }
  expect(f.calls).toEqual([]);
});

test("Genjutsu cancellation requires the captured account/workspace and same-origin browser request", async () => {
  const f = await fixture("cancel_scope");
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  for (const captured of [null, "", workbenchScopeFor("another", "creator"), workbenchScopeFor(f.store().workspace!.id, "another")])
    expect((await f.post("own-take", { scope: captured })).status).toBe(409);
  expect((await f.post("own-take", { origin: "https://attacker.invalid" })).status).toBe(403);
  expect(f.calls).toEqual([]);
});

test("Genjutsu cancellation hides foreign, missing, deleted and malformed generation IDs", async () => {
  const f = await fixture("cancel_tenants");
  for (const id of ["foreign-take", "missing", "../own-take", "x".repeat(161)])
    expect((await f.post(id)).status).toBe(404);
  f.setStore(f.stores[1]);
  expect((await f.post("own-take")).status).toBe(404);
  f.setStore(f.stores[0]);
  await f.remove();
  expect((await f.post()).status).toBe(404);
  expect(f.calls).toEqual([]);
});

test("Genjutsu cancellation permits only the creator or workspace admin, including scoped render tokens", async () => {
  const f = await fixture("cancel_actor"), original = f.store();
  f.setStore({ ...original, user: { ...creator, id: "other-member" } });
  expect((await f.post()).status).toBe(403);
  expect(f.calls).toEqual([]);
  for (const user of [creator, { ...creator, id: "admin", role: "admin" as const }]) {
    f.setStore({ ...original, user });
    expect((await f.post()).status).toBe(202);
    expect(f.calls.at(-1)).toMatchObject({ id: "own-take", workspaceId: original.workspace!.id, userId: user.id });
  }
  f.setStore({ ...original, token: { id: "render", name: "Render", scope: "render", capUsd: null } });
  expect((await f.post("own-take", { scope: null })).status).toBe(202);
  expect(f.calls.at(-1)).toMatchObject({ id: "own-take", workspaceId: original.workspace!.id, userId: creator.id, tokenScope: "render" });
  expect(f.calls).toHaveLength(3);
});

test("Genjutsu cancellation acknowledgement is private 202 and never claims completion or a refund", async () => {
  const f = await fixture("cancel_ack"), before = await f.snapshot();
  const response = await f.post();
  expect(response.status).toBe(202);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ status: "requested" });
  expect(await f.snapshot()).toEqual(before);
  for (const status of ["running", "succeeded", "failed", "cancelled"]) {
    f.result(status);
    const current = await f.post();
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ status });
    expect(await f.snapshot()).toEqual(before);
  }
});

test("Genjutsu cancellation preserves safe typed errors and redacts unexpected provider failures", async () => {
  const f = await fixture("cancel_errors");
  const { HiggsfieldHttpError } = await import("../../lib/higgsfield");
  f.fail(new HiggsfieldHttpError(409, "The provider acknowledgement is not available yet."));
  const conflict = await f.post();
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "The provider acknowledgement is not available yet." });
  f.fail(new Error("private-provider-token-and-response"));
  const failed = await f.post();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ error: "Cancellation could not be confirmed. Refresh this existing take before trying again." });
});
