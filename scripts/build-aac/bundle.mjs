// AAC-only adaptation of Mediabunny's scripts/bundle.ts, MPL-2.0.
// Copyright (c) 2026-present, Vanilagy and contributors.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import typescript from "typescript";
import PluginExternalGlobal from "esbuild-plugin-external-global";

const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const workerPlugin = new URL(
  "./upstream-inlined-workers.ts.txt",
  import.meta.url,
);
const transpiled = typescript.transpileModule(
  await fs.readFile(workerPlugin, "utf8"),
  {
    compilerOptions: {
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2021,
    },
  },
).outputText;
const pluginPath = new URL("./.inlined-workers.mjs", import.meta.url);
await fs.writeFile(pluginPath, transpiled);
const { inlineWorkerPlugin } = await import(
  pathToFileURL(pluginPath.pathname).href
);

const banner = `/*!
 * Copyright (c) 2026-present, Vanilagy and contributors.
 * MPL-2.0 wrapper; FFmpeg AAC/libavutil LGPL-2.1-or-later.
 * Particl source rebuild 1.56.2-particl.1. See NOTICE.txt and corresponding-source README.
 */`;
for (const format of ["esm", "iife"]) {
  for (const minify of [false, true]) {
    await esbuild.build({
      absWorkingDir: source,
      entryPoints: ["packages/aac-encoder/src/index.ts"],
      outfile: path.join(
        output,
        "dist/bundles",
        `mediabunny-aac-encoder${minify ? ".min" : ""}.${format === "esm" ? "mjs" : "js"}`,
      ),
      bundle: true,
      target: "es2021",
      format,
      minify,
      banner: { js: banner },
      legalComments: "none",
      ...(format === "esm"
        ? { external: ["mediabunny"] }
        : {
            globalName: "MediabunnyAacEncoder",
            footer: {
              js: 'if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, MediabunnyAacEncoder)',
            },
          }),
      plugins: [
        ...(format === "iife"
          ? [
              PluginExternalGlobal.externalGlobalPlugin({
                mediabunny: "Mediabunny",
              }),
            ]
          : []),
        inlineWorkerPlugin({
          define: { "import.meta.url": '""' },
          legalComments: "none",
        }),
      ],
    });
  }
}
await fs.rm(pluginPath);
