import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

/**
 * Load an App Router route file with its `@/` dependencies supplied by the
 * test: a real lib module where the behaviour is under test, a recorder
 * where it would reach a session, a cookie jar or a mail provider. Node
 * built-ins and `next/server` load as themselves; any other dependency the
 * test did not name fails loudly.
 */
export function loadRoute<T>(file: string, mocks: Record<string, unknown>): T {
  const real = createRequire(path.resolve("package.json"));
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const mod = { exports: {} as T };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith("node:") || name === "next/server") return real(name);
      throw new Error("Unexpected route dependency " + name);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}
