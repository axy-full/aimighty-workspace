import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { MediaSourceError } from "../../lib/mediaBindings";
import {
  NoTenantError,
  runWithStore,
  type TenantStore,
} from "../../lib/tenant";
import { workbenchScopeFor } from "../../lib/workbench/request-scope";

/** Execute the actual wrapper while controlling only session resolution. */
function wrapper() {
  const source = ts.createSourceFile(
    "auth.ts",
    readFileSync("lib/auth.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const fn = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "withTenant",
  )!;
  const compiled = ts.transpileModule(fn.getText(source), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  let store = {
    workspace: { id: "workspace" },
    user: { id: "owner" },
  } as TenantStore;
  let failure: Error | null = null;
  const logs: string[] = [];
  const exports = {} as Pick<typeof import("../../lib/auth"), "withTenant">;
  new Function(
    "exports",
    "resolveStore",
    "runWithStore",
    "NoTenantError",
    "MediaSourceError",
    "workbenchScopeFor",
    "console",
    "recoveryRoute",
    compiled,
  )(
    exports,
    async () => {
      if (failure) throw failure;
      return store;
    },
    runWithStore,
    NoTenantError,
    MediaSourceError,
    workbenchScopeFor,
    { error: (line: string) => logs.push(line) },
    (handler: unknown) => handler,
  );
  return {
    withTenant: exports.withTenant,
    setStore: (value: TenantStore) => {
      store = value;
    },
    fail: (value: Error) => {
      failure = value;
    },
    logs,
  };
}
function request(method: string, scope?: string) {
  return new Request("http://localhost/api/private", {
    method,
    headers: scope === undefined ? {} : { "X-Workbench-Scope": scope },
  });
}

test("MFA enrollment is required before any private handler executes, while scoped identity reads remain available", async () => {
  const api = wrapper();
  api.setStore({ workspace: { id: "workspace" }, user: { id: "owner" }, mfaRequired: true } as TenantStore);
  let calls = 0;
  const handler = api.withTenant(async () => { calls++; return Response.json({ ok: true }); });
  for (const method of ["GET", "HEAD", "POST", "PATCH", "DELETE"]) {
    const response = await handler(request(method, workbenchScopeFor("workspace", "owner")), undefined);
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ code: "MFA_REQUIRED", securityUrl: "/account/security" });
  }
  expect(calls).toBe(0);
  const identity = api.withTenant(async () => Response.json({ enrollment: true }), { allowMfaEnrollment: true });
  expect((await identity(request("GET", workbenchScopeFor("workspace", "owner")), undefined)).status).toBe(200);
  expect((await identity(request("GET", workbenchScopeFor("workspace", "other")), undefined)).status).toBe(409);
});

test("captured scope is authoritative for every method and stale requests never enter the handler", async () => {
  const api = wrapper();
  let calls = 0;
  const handler = api.withTenant(async () => {
    calls++;
    return Response.json({ ok: true });
  });
  for (const method of [
    "GET",
    "HEAD",
    "OPTIONS",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ]) {
    for (const scope of [
      "",
      workbenchScopeFor("workspace", "old-user"),
      workbenchScopeFor("old-workspace", "owner"),
    ])
      expect((await handler(request(method, scope), undefined)).status).toBe(
        409,
      );
    expect(
      (
        await handler(
          request(method, workbenchScopeFor("workspace", "owner")),
          undefined,
        )
      ).status,
    ).toBe(200);
  }
  expect(calls).toBe(7);
  for (const store of [
    { workspace: null, user: null },
    { workspace: null, user: { id: "owner" } },
    { workspace: { id: "workspace" }, user: null },
  ] as TenantStore[]) {
    api.setStore(store);
    expect(
      (
        await handler(
          request("GET", workbenchScopeFor("workspace", "owner")),
          undefined,
        )
      ).status,
    ).toBe(409);
  }
  expect(calls).toBe(7);
});

test("opt-in missing-scope enforcement preserves safe reads, legacy endpoints and explicit API tokens", async () => {
  const api = wrapper();
  let calls = 0;
  const run = async () => {
    calls++;
    return Response.json({ ok: true });
  };
  const strict = api.withTenant(run, { requireRequestScope: true });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    expect((await strict(request(method), undefined)).status).toBe(409);
  for (const method of ["GET", "HEAD", "OPTIONS"])
    expect((await strict(request(method), undefined)).status).toBe(200);
  expect((await api.withTenant(run)(request("POST"), undefined)).status).toBe(
    200,
  );
  api.setStore({
    workspace: { id: "workspace" },
    user: { id: "owner" },
    token: { scope: "render" },
  } as TenantStore);
  expect((await strict(request("POST"), undefined)).status).toBe(200);
  expect(
    (
      await strict(
        request("POST", workbenchScopeFor("other", "owner")),
        undefined,
      )
    ).status,
  ).toBe(409);
  api.setStore({
    workspace: { id: "workspace" },
    user: { id: "owner" },
    token: { scope: "read" },
  } as TenantStore);
  expect((await strict(request("POST"), undefined)).status).toBe(403);
  expect(
    (
      await api.withTenant(run, {
        requireRequestScope: true,
        readOnlyPostTransport: true,
      })(request("POST"), undefined)
    ).status,
  ).toBe(200);
  expect(calls).toBe(6);
});

test("source failures produce useful 409s while session-resolution logs contain no raw credentials", async () => {
  const api = wrapper();
  const source = api.withTenant(async () => {
    throw new MediaSourceError("A referenced upload is no longer available.");
  });
  const response = await source(request("POST"), undefined);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "A referenced upload is no longer available.",
  });
  api.fail(new Error("database token=DO-NOT-LOG-THIS"));
  expect((await source(request("POST"), undefined)).status).toBe(503);
  expect(api.logs).toEqual([
    JSON.stringify({ event: "session_resolution_failed" }),
  ]);
});

test("anonymous missing-scope requests retain normal 401 authentication while stale provided scope is refused", async () => {
  const api = wrapper();
  api.setStore({ workspace: null, user: null });
  let entered = false;
  const protectedHandler = api.withTenant(
    async () => {
      entered = true;
      throw new NoTenantError();
    },
    { requireRequestScope: true },
  );
  expect((await protectedHandler(request("POST"), undefined)).status).toBe(401);
  expect(entered).toBe(true);
  entered = false;
  expect(
    (
      await protectedHandler(
        request("POST", workbenchScopeFor("workspace", "owner")),
        undefined,
      )
    ).status,
  ).toBe(409);
  expect(entered).toBe(false);
  api.setStore({ workspace: null, user: { id: "owner" } } as TenantStore);
  expect((await protectedHandler(request("POST"), undefined)).status).toBe(409);
});
