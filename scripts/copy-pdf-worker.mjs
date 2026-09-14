import { mkdir, copyFile, cp } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const version = require("pdfjs-dist/package.json").version;
if (version !== "6.3.289")
  throw new Error(
    "Update the screenplay PDF worker version before changing pdfjs-dist.",
  );
const directory = new URL("../public/vendor/pdfjs-6.3.289/", import.meta.url);
await mkdir(directory, { recursive: true });
await copyFile(
  require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
  new URL("pdf.worker.min.mjs", directory),
);
await copyFile(
  require.resolve("pdfjs-dist/LICENSE"),
  new URL("LICENSE", directory),
);

for (const folder of ["cmaps", "standard_fonts"])
  await cp(
    new URL(
      `../${folder}/`,
      pathToFileURL(require.resolve("pdfjs-dist/build/pdf.mjs")),
    ),
    new URL(folder + "/", directory),
    { recursive: true },
  );
