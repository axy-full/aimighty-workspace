import { test, expect } from "@playwright/test";
import {
  assemblePages,
  type ScreenplayImport,
} from "../../lib/workbench/screenplay";
import { requestOcr, applyOcrPage, reviewOcrPage } from "../helpers/screenplayOcrState";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";
import nextConfig from "../../next.config";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const source = (): ScreenplayImport => ({
  ...assemblePages(["INT. ORIGINAL - DAY\nPreserve this text.", "2.", ""]),
  sha256: "a".repeat(64),
});
function recognized() {
  return applyOcrPage(
    requestOcr(source(), [2, 3]),
    2,
    "EXT. DOCK - NIGHT\nKEEPER\nA remembered moment.",
    94,
  );
}

test("server save schema requires unique, complete and reviewed OCR provenance; earlier imports remain valid", () => {
  const project = newProject("OCR review");
  const result = applyOcrPage(
    recognized(),
    3,
    "EXT. ROAD - DAWN\nAn open road.",
    87,
  );
  project.script = result.text;
  project.assets = [
    {
      id: "source",
      uploadId: "upl_source",
      kind: "document",
      category: "Screenplay",
      name: "Scan.pdf",
      url: "/api/uploads/upl_source",
      mime: "application/pdf",
      description: "",
      prompt: "",
      refs: [],
      status: "Draft",
      locked: false,
      version: 1,
    },
  ];
  project.scriptSource = {
    assetId: "source",
    filename: "Scan.pdf",
    sha256: result.sha256,
    pages: result.pages,
    importedAt: new Date().toISOString(),
    edited: false,
    acknowledgedEmptyPages: [],
    ocr: result.ocr,
  };
  const valid = () => saveSchema.safeParse({ project, revision: 0 }).success;
  expect(valid()).toBe(false);
  project.scriptSource.ocr = reviewOcrPage(
    reviewOcrPage(result, 2, true),
    3,
    true,
  ).ocr;
  expect(valid()).toBe(true);
  const reviewed = structuredClone(project.scriptSource.ocr!);
  project.scriptSource.ocr!.requestedPages.push(1);
  expect(valid()).toBe(false);
  project.scriptSource.ocr = {
    ...reviewed,
    pages: [reviewed.pages[0], reviewed.pages[0]],
  };
  expect(valid()).toBe(false);
  project.scriptSource.ocr = { ...reviewed, requestedPages: [2, 4] };
  expect(valid()).toBe(false);
  delete project.scriptSource.ocr;
  expect(valid()).toBe(true);
});

test("OCR assets match installed pinned package hashes and WASM is allowed only in its isolated worker", async () => {
  const manifest = JSON.parse(
    readFileSync("public/vendor/tesseract-7.0.0/manifest.json", "utf8"),
  );
  for (const [file, expected] of Object.entries(manifest.sha256))
    expect(
      createHash("sha256")
        .update(readFileSync("public/vendor/tesseract-7.0.0/" + file))
        .digest("hex"),
    ).toBe(expected);
  const entries = await nextConfig.headers!();
  const policy = entries.find(
    (entry) => entry.source === "/vendor/tesseract-7.0.0/worker.min.js",
  )!.headers[0].value;
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(policy).toContain("connect-src 'self'");
  expect(policy).toContain("worker-src 'none'");
  expect(policy).not.toContain("'unsafe-eval'");
  expect(policy).not.toContain("https:");
});
