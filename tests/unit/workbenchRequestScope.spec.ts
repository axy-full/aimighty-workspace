import * as zlib from "node:zlib";
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { newProject } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";
import * as requestBody from "../../lib/workbench/request-body";
import * as requestScope from "../../lib/workbench/request-scope";
import * as saveProblem from "../../lib/workbench/save-problem";

/** Execute the real route with storage spies: a rejected tab must not reach data. */
function route() {
  const calls: string[] = [];
  const record = (name: string, value: unknown) => async () => {
    calls.push(name);
    return value;
  };
  const draft = newProject("Private production");
  const mocks: Record<string, unknown> = {
    "@/lib/workbench/request-body": requestBody,
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireSession: async () => ({
        user: { id: "new-account", name: "New account" },
      }),
    },
    "@/lib/tenant": { requireTenant: () => ({ id: "current-workspace" }) },
    "@/lib/workbench/request-scope": requestScope,
    "@/lib/db": { db: () => ({ execute: record("query", { rows: [] }) }) },
    "@/lib/workbench/studio-schema": { saveSchema },
    "@/lib/workbench/save-problem": saveProblem,
    "@/lib/workbench/studio": { newProject },
    /* Real: a large project answer leaves gzipped. */
    "node:zlib": zlib,
    "@/lib/workbench/records": {
      workbenchReady: record("ready", undefined),
      readDraft: record("read", { project: draft, revision: 1 }),
      saveDraft: record("save", { revision: 1 }),
      mapNodeShot: record("map", "shot"),
      publishBible: record("publish", { version: 1 }),
    },
  };
  const compiled = ts.transpileModule(
    readFileSync("app/api/workbench/projects/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  vm.runInNewContext(compiled, {
    exports,
    Response,
    URL,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error(`Unexpected dependency ${name}`);
      return mocks[name];
    },
  });
  return { exports, calls, draft };
}

for (const [label, captured] of [
  [
    "another account in the same workspace",
    requestScope.workbenchScopeFor("current-workspace", "old-account"),
  ],
  [
    "another workspace for the same account",
    requestScope.workbenchScopeFor("old-workspace", "new-account"),
  ],
  ["an unstamped old browser", null],
] as const) {
  test(`${label} cannot save, publish, map or open before touching storage`, async () => {
    const { exports, calls, draft } = route();
    for (const [method, body] of [
      ["PUT", { project: draft, revision: 0 }],
      [
        "POST",
        { action: "publish", projectId: draft.id, expectedBibleVersion: 0 },
      ],
      ["POST", { action: "map-shot", projectId: draft.id, nodeId: "a" }],
      ["POST", { action: "open", projectId: "existing-production" }],
    ] as const) {
      const response = await exports[method](
        new Request("http://localhost/api/workbench/projects", {
          method,
          headers: captured ? { "X-Workbench-Scope": captured } : {},
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("account or workspace changed"),
      });
      expect(calls).toEqual([]);
    }
    if (captured) {
      expect(
        (
          await exports.GET(
            new Request("http://localhost/api/workbench/projects?id=private", {
              headers: { "X-Workbench-Scope": captured },
            }),
          )
        ).status,
      ).toBe(409);
      expect(calls).toEqual([]);
    }
  });
}

test("the current captured account can save and publish; ordinary GET clients stay compatible", async () => {
  const { exports, calls, draft } = route();
  const headers = {
    "X-Workbench-Scope": requestScope.workbenchScopeFor(
      "current-workspace",
      "new-account",
    ),
  };
  expect(
    (
      await exports.PUT(
        new Request("http://localhost/api/workbench/projects", {
          method: "PUT",
          headers,
          body: JSON.stringify({ project: draft, revision: 0 }),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls).toContain("save");
  expect(
    (
      await exports.POST(
        new Request("http://localhost/api/workbench/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({
            action: "publish",
            projectId: draft.id,
            expectedBibleVersion: 0,
          }),
        }),
      )
    ).status,
  ).toBe(200);
  expect(calls).toContain("publish");
  expect(
    (await exports.GET(new Request("http://localhost/api/workbench/projects")))
      .status,
  ).toBe(200);
});

test("a save the schema refuses says which rule it broke, not a generic line", async () => {
  const { exports, calls, draft } = route();
  const headers = { "X-Workbench-Scope": requestScope.workbenchScopeFor("current-workspace", "new-account") };
  const put = async (project: unknown) => {
    const response = await exports.PUT(new Request("http://localhost/api/workbench/projects", { method: "PUT", headers, body: JSON.stringify({ project, revision: 0 }) }));
    return { status: response.status, error: ((await response.json()) as { error: string }).error };
  };
  expect(await put({ ...draft, name: "x".repeat(101) })).toEqual({ status: 400, error: "Check the project's name: keep it to 100 characters." });
  expect(await put({ ...draft, scriptSource: { assetId: "missing", filename: "script.pdf", sha256: "a".repeat(64), pages: [], importedAt: "2026-09-25", edited: false, acknowledgedEmptyPages: [] } })).toEqual({ status: 400, error: "Keep the uploaded screenplay source in the asset library." });
  expect(await put({ ...draft, fps: 23 })).toEqual({ status: 400, error: "Check the project's fps: it is not valid." });
  expect(calls).not.toContain("save");
});
