import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
/**
 * The two helpers publicLinkOrigin.spec.ts needs from release/1's tests/unit/demo-gaps-l5-harness.ts, copied
 * verbatim (the rest of that harness serves specs main does not have). Each spec file gets its own temporary databases.
 */
export function freshDatabases(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `particl-l5-${tag}-`));
  process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
  process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
  process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
  process.env.ENGINE_MOCK = "1";
  return dir;
}

/** Transpiles one file and runs it with the given modules standing in for its imports. */
export function load<T>(file: string, dependencies: Record<string, unknown>): T {
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
