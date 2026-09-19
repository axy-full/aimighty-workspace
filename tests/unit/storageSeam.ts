import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

export type IsolatedOptions = {
  /** Replaces the module's `process` (env, cwd) without touching the real one. */
  process?: NodeJS.Process | Record<string, unknown>;
  /** Replaces the module's `fetch`; the R2 backend binds the global late, so a fake here reaches it. */
  fetch?: typeof fetch;
};

const SEAM = path.resolve("lib/storage");

/**
 * Transpiles one TypeScript module and runs it with an injected `require`,
 * `process` and `fetch`, so a spec exercises the real implementation with only
 * its remote edges replaced. Modules under lib/storage/ that it imports load
 * the same way and share the injections: a fake `@vercel/blob` or `fetch`
 * handed to lib/storage.ts reaches the backend behind it. Everything else
 * resolves through the ordinary require.
 */
export function loadIsolated<T>(file: string, dependencies: Record<string, unknown>, options: IsolatedOptions = {}): T {
  const cache = new Map<string, { exports: unknown }>();
  const processObject = options.process ?? process;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const load = (filename: string): unknown => {
    const cached = cache.get(filename);
    if (cached) return cached.exports;
    const require = createRequire(filename);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const isolatedRequire = (name: string) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filename), name);
        if (resolved.startsWith(SEAM + path.sep)) return load(resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
      }
      return require(name);
    };
    new Function("require", "module", "exports", "process", "fetch", compiled)(isolatedRequire, mod, mod.exports, processObject, fetchImpl);
    return mod.exports;
  };
  return load(path.resolve(file)) as T;
}
