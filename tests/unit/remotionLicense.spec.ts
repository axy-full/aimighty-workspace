import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createRealRenderer } from "../../remotion/node/renderer";

/* Owner decision, 14 Oct 2026: send NO licence key and NO events to Remotion. Server-side with no key the renderer sends
   nothing, which the Free License allows; the worker stays sealed (no internet). Remotion is pinned to 4.x, and an upgrade
   to 5.x needs the owner first (5.0 may require a key). */

const root = process.cwd();
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const filesIn = (dir: string, pattern: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? filesIn(full, pattern) : pattern.test(name) ? [full] : [];
});

test("the export command never passes a licence key, and nothing in the code can reach Remotion's usage endpoint", async () => {
  // Every call the renderer makes, recorded; fetch itself fails the test if anything uses it.
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("The export command must not use the network."); }) as typeof fetch;
  try {
    const record = (fn: string) => async (args: Record<string, unknown>) => { calls.push({ fn, args }); return { id: "x", width: 480, height: 270, fps: 30, durationInFrames: 30, props: {} }; };
    const renderer = createRealRenderer({ loadModule: async () => ({ ensureBrowser: record("ensureBrowser"), selectComposition: record("selectComposition"), renderMedia: record("renderMedia"), renderStill: record("renderStill") }) });
    await renderer.prepare();
    const composition = await renderer.selectComposition({ serveUrl: "/serve", id: "title-card", inputProps: {} });
    await renderer.renderVideo({ serveUrl: "/serve", composition, inputProps: {}, outputLocation: "/out/export.mp4", concurrency: 2 });
    await renderer.renderStill({ serveUrl: "/serve", composition, inputProps: {}, frame: 3, outputLocation: "/out/still-3.png" });
  } finally { globalThis.fetch = realFetch; }
  expect(calls.map((c) => c.fn)).toEqual(["ensureBrowser", "selectComposition", "renderMedia", "renderStill"]);
  for (const call of calls) {
    expect(Object.keys(call.args), call.fn).not.toContain("licenseKey");
    expect(Object.keys(call.args), call.fn).not.toContain("apiKey");
    expect(JSON.stringify(call.args), call.fn).not.toMatch(/free-license|licen[sc]e/i);
  }
});

test("no source or build file names a licence key, the licensing package or the usage endpoint", () => {
  const files = [...filesIn(path.join(root, "remotion", "src"), /\.(ts|tsx)$/), ...filesIn(path.join(root, "remotion", "node"), /\.(ts|mjs)$/), ...filesIn(path.join(root, "ops", "remotion-worker"), /\.(mjs|yaml)$|^Dockerfile$/)];
  expect(files.length).toBeGreaterThan(15);
  const banned = [/licenseKey/, /apiKey/, /free-license/, /register-usage/, /remotion\.pro/, /@remotion\/licensing/, /LicensingInternals/, /REMOTION_LICENSE/i];
  for (const file of files) {
    const code = strip(readFileSync(file, "utf8"));
    for (const pattern of banned) expect(code, `${path.relative(root, file)} must not match ${pattern}`).not.toMatch(pattern);
  }
});

test("Remotion stays on 4.x: every remotion and @remotion/* version, in package.json and in the lockfile, starts with 4.", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "remotion", "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const declared = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([name]) => name === "remotion" || name.startsWith("@remotion/"));
  expect(declared.map(([name]) => name).sort()).toEqual(["@remotion/bundler", "@remotion/renderer", "remotion"]);
  for (const [name, version] of declared) expect(version, `${name} must be an exact 4.x pin, not a range`).toMatch(/^4\.\d+\.\d+$/);
  const lock = JSON.parse(readFileSync(path.join(root, "remotion", "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
  const locked = Object.entries(lock.packages).filter(([key]) => /node_modules\/(remotion|@remotion\/[^/]+)$/.test(key));
  expect(locked.length).toBeGreaterThan(10);
  for (const [key, entry] of locked) expect(entry.version, key).toMatch(/^4\./);
});

test("the READMEs say that a move to Remotion 5.x needs the owner first", () => {
  for (const file of ["remotion/README.md", "ops/remotion-worker/README.md"]) {
    expect(readFileSync(path.join(root, file), "utf8"), file).toContain("Upgrading to Remotion 5.x needs the owner's approval first (NEEDS AKSHAY): 5.0 may require a licence key.");
  }
});
