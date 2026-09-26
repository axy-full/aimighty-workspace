import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}

/** Nothing advances a Rig run (lib/runs.ts): the Rig must never open a run view that shows "Running" with no runner. */
test("the Rig's Run opens Pipelines, where runs execute, and old run links follow it there", async () => {
  const bar = load<typeof import("../../components/rig/RigBar")>("components/rig/RigBar.tsx", {
    "next/navigation": { useRouter: () => ({ push: () => {} }) },
    "@/components/ui": {}, "@/lib/usePhone": {}, "@/components/atomik/Ring": {},
    "@/components/atomik/AtomikProvider": {}, "@/lib/atomikRail": {},
  });
  expect(bar.rigHrefs("proj 1", "board_1")).toEqual({
    canvas: "/rig/canvas/board_1",
    recipes: "/rig/recipes/proj%201",
    run: "/pipelines?projectId=proj%201",
  });
  expect(bar.rigHrefs("proj_2").canvas).toBe("/rig/canvas/new?project=proj_2");
  expect(bar.pipelinesHref(null)).toBe("/pipelines");

  const redirected: string[] = [];
  const page = load<typeof import("../../app/(app)/rig/run/[runId]/page")>("app/(app)/rig/run/[runId]/page.tsx", {
    "next/navigation": { redirect: (to: string) => { redirected.push(to); throw new Error("NEXT_REDIRECT"); } },
  });
  for (const search of [{ project: "proj 1" }, {}, { project: ["a", "b"] }])
    await expect(page.default({ searchParams: Promise.resolve(search) })).rejects.toThrow("NEXT_REDIRECT");
  expect(redirected).toEqual(["/pipelines?projectId=proj%201", "/pipelines", "/pipelines"]);

  // The recipe screen no longer starts a run that nothing would advance.
  const recipes = readFileSync(path.resolve("app/(app)/rig/recipes/[projectId]/page.tsx"), "utf8");
  expect(recipes).not.toContain("/api/rig/runs");
  expect(recipes).not.toContain("Run to first checkpoint");
});
