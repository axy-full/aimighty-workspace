import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const publicRoot = path.join(root, "public/open-source");
const provenance = JSON.parse(
  readFileSync(
    path.join(publicRoot, "aac-1.56.2-particl.1-provenance.json"),
    "utf8",
  ),
);
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

test("the installed AAC library matches the publicly downloadable rebuilt package", () => {
  const app = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  expect(app.dependencies["mediabunny"]).toBe("1.56.2");
  expect(app.dependencies["@mediabunny/aac-encoder"]).toBe(
    `file:public/open-source/${provenance.packageArchive.file}`,
  );
  const installed = path.join(root, "node_modules/@mediabunny/aac-encoder");
  expect(
    JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"))
      .version,
  ).toBe(provenance.package.version);
  expect(
    hash(readFileSync(path.join(publicRoot, provenance.packageArchive.file))),
  ).toBe(provenance.packageArchive.sha256);
  for (const [file, expected] of Object.entries(provenance.artifacts)) {
    expect(hash(readFileSync(path.join(installed, file))), file).toBe(expected);
  }
});

test("corresponding source, link recipe and license evidence remain downloadable together", () => {
  const archive = path.join(publicRoot, provenance.sourceArchive.file);
  expect(hash(readFileSync(archive))).toBe(provenance.sourceArchive.sha256);
  const prefix = "aac-1.56.2-particl.1-source/";
  const list = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const entries = new Set(list.trim().split("\n"));
  for (const filename of Object.keys(provenance.sources))
    expect(entries.has(prefix + filename), filename).toBe(true);
  for (const [filename, expected] of Object.entries(provenance.recipe)) {
    expect(
      hash(execFileSync("tar", ["-xOzf", archive, prefix + filename])),
    ).toBe(expected);
  }
  for (const filename of [
    "source/ffmpeg/libavcodec/aacenc.c",
    "source/mediabunny/packages/aac-encoder/src/bridge.c",
    "source/mediabunny/packages/aac-encoder/src/encode.worker.ts",
  ]) {
    expect(
      hash(execFileSync("tar", ["-xOzf", archive, prefix + filename])),
    ).toBe(provenance.sources[filename]);
  }
  const config = execFileSync(
    "tar",
    ["-xOzf", archive, prefix + "evidence/config.h"],
    { encoding: "utf8" },
  );
  expect(config).toContain(
    '#define FFMPEG_LICENSE "LGPL version 2.1 or later"',
  );
  for (const flag of ["GPL", "NONFREE", "VERSION3"])
    expect(config).toContain(`#define CONFIG_${flag} 0`);
  expect(entries.has(prefix + "evidence/bridge.o")).toBe(true);
  const notice = readFileSync(
    path.join(root, "public/licenses/mediabunny.txt"),
    "utf8",
  );
  expect(notice).toContain(`/open-source/${provenance.sourceArchive.file}`);
  expect(notice).toContain("/licenses/LGPL-2.1.txt");
});
