// Builds what the worker image carries: the compositions' webpack bundle (build/bundle) and the
// fixed export command as one file (build/cli.mjs). Run at image build time, never at runtime.
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build");
await rm(out, { recursive: true, force: true });

await bundle({
  entryPoint: path.join(root, "src", "index.ts"),
  outDir: path.join(out, "bundle"),
  publicDir: path.join(root, "public"),
  onProgress: () => {},
});

await build({
  entryPoints: [path.join(root, "node", "cli.ts")],
  outfile: path.join(out, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // @remotion/renderer keeps its native binaries next to itself: it stays a runtime dependency.
  external: ["@remotion/renderer"],
  logLevel: "warning",
});
console.log("built", path.relative(process.cwd(), out));
