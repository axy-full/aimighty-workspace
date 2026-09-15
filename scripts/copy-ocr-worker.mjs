import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
for (const [name, expected] of [
  ["tesseract.js", "7.0.0"],
  ["tesseract.js-core", "7.0.0"],
  ["@tesseract.js-data/eng", "1.0.0"],
]) {
  if (require(name + "/package.json").version !== expected)
    throw new Error(`Requalify OCR before changing ${name}.`);
}
const directory = new URL("../public/vendor/tesseract-7.0.0/", import.meta.url);
await mkdir(new URL("core/", directory), { recursive: true });
await mkdir(new URL("eng-1.0.0/", directory), { recursive: true });
const assets = [
  ["tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["tesseract.js/LICENSE.md", "LICENSE-tesseract"],
  ["tesseract.js-core/LICENSE", "LICENSE-core"],
  ["@tesseract.js-data/eng/package.json", "eng-1.0.0/package.json"],
  [
    "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
    "eng-1.0.0/eng.traineddata.gz",
  ],
  ...["lstm", "simd-lstm", "relaxedsimd-lstm"].map((variant) => [
    `tesseract.js-core/tesseract-core-${variant}.wasm.js`,
    `core/tesseract-core-${variant}.wasm.js`,
  ]),
];
const hashes = {};
for (const [source, target] of assets) {
  const path = require.resolve(source);
  await copyFile(path, new URL(target, directory));
  hashes[target] = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
await writeFile(
  new URL("manifest.json", directory),
  JSON.stringify(
    {
      engine: "tesseract.js 7.0.0 / tesseract.js-core 7.0.0 (Apache-2.0)",
      language:
        "@tesseract.js-data/eng 1.0.0, 4.0.0_best_int (package declares MIT)",
      sources: [
        "https://github.com/naptha/tesseract.js",
        "https://github.com/naptha/tesseract.js-core",
        "https://github.com/naptha/tessdata",
      ],
      sha256: hashes,
    },
    null,
    2,
  ) + "\n",
);
