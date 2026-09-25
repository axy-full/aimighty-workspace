import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

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

/** A library list never waits on a provider poll or a master download: reconciliation runs after the response. */
test("the jobs list answers before reconciling what is in flight, and reconciles after the response", async () => {
  const { NextResponse } = createRequire(path.resolve("package.json"))("next/server") as typeof import("next/server");
  const later: (() => Promise<unknown>)[] = [];
  let syncs = 0, finish!: () => void;
  const slow = new Promise<void>((resolve) => { finish = resolve; });
  const route = load<typeof import("../../app/api/jobs/route")>("app/api/jobs/route.ts", {
    "next/server": { NextResponse, after: (fn: () => Promise<unknown>) => { later.push(fn); } },
    "@/lib/recovery": { reserveRecoveryContinuation: async (_kind: string, fn: () => Promise<unknown>) => fn },
    "@/lib/auth": { requireUser: async () => ({ user: { id: "member", role: "member" }, token: null }), withTenant: (handler: unknown) => handler },
    "@/lib/tenant": { requireTenant: () => ({ id: "ws_list" }) },
    "@/lib/jobs": {
      listGenerations: async () => [],
      // A render landing now would download its master here; the list must not wait for it.
      syncActive: async () => { syncs++; await slow; },
    },
  });
  const res = await (route.GET as unknown as (req: Request) => Promise<Response>)(new Request("http://unit.invalid/api/jobs?limit=5"));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ generations: [] });
  expect(syncs).toBe(0);
  expect(later).toHaveLength(1);
  const run = later[0]();
  expect(syncs).toBe(1);
  finish();
  await run;

  // sync=0 reads never reconcile at all.
  later.length = 0;
  await (route.GET as unknown as (req: Request) => Promise<Response>)(new Request("http://unit.invalid/api/jobs?limit=5&sync=0"));
  expect(later).toHaveLength(0);
});
