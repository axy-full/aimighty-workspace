import { readProjectBody } from "../../lib/workbench/request-body";
import { test, expect } from "@playwright/test";
import {
  assemblePages,
  parseScreenplay,
  screenplayPageText,
  MAX_SCRIPT_CHARS,
} from "../../lib/workbench/screenplay";
import { newProject } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";

function sourceProject() {
  const p = newProject("Complete feature script");
  const extracted = assemblePages(
    Array.from(
      { length: 120 },
      (_, i) =>
        `${i + 1} EXT. LOCATION ${i + 1} - DAY ${i + 1}\n\n${"A visible action. ".repeat(90)}\n\nACTOR\nThis is the final line of scene ${i + 1}.`,
    ),
  );
  p.script = extracted.text;
  p.assets = [
    {
      id: "source",
      uploadId: "upload-script",
      url: "/api/uploads/upload-script",
      name: "Feature.pdf",
      kind: "document",
      category: "Screenplay",
      mime: "application/pdf",
      description: "",
      prompt: "",
      refs: [],
      status: "Draft",
      locked: false,
      version: 1,
    },
  ];
  p.scriptSource = {
    assetId: "source",
    sha256: "a".repeat(64),
    filename: "Feature.pdf",
    pages: extracted.pages,
    importedAt: new Date().toISOString(),
    edited: false,
    acknowledgedEmptyPages: [],
  };
  return p;
}
test("scene continuity across pages preserves numbering suffixes and excludes title matter from scene count", () => {
  const extracted = assemblePages([
    "A FEATURE\nWritten by An Author\n\n12A INT./EXT. CAR - NIGHT 12A\n\nWe enter the vehicle.",
    "The same scene continues.\n\n13 EXT. DOCK - DAWN 13\n\nKEEPER (V.O.)\nI can hear you.",
  ]);
  const scenes = parseScreenplay(extracted.text, extracted.pages);
  expect(scenes).toHaveLength(2);
  expect(scenes[0]).toMatchObject({ number: "12A", pageStart: 1, pageEnd: 2 });
  expect(scenes[0].body).toContain("same scene continues");
  expect(scenes[1].characters).toEqual(["KEEPER"]);
  expect(extracted.text).toContain("Written by");
});
test("empty and scanned pages are flagged and character/page limits fail without returning a partial result", () => {
  expect(
    assemblePages(["INT. SET - DAY\nAction.", "2.\n", ""]).emptyPages,
  ).toEqual([2, 3]);
  expect(() => assemblePages(Array(401).fill("text"))).toThrow(/400/);
  expect(() => assemblePages(["x".repeat(MAX_SCRIPT_CHARS)])).toThrow(
    /Nothing was imported/,
  );
});
test("positioned PDF text joins scene-number columns without scrambling line and dialogue order", () => {
  const item = (str: string, x: number, y: number, width = 20) => ({
    str,
    transform: [12, 0, 0, 12, x, y],
    width,
    height: 12,
  });
  const text = screenplayPageText([
    item("Hello there.", 150, 610),
    item("7", 540, 700),
    item("7", 40, 700),
    item("EXT. PARK - DAY", 72, 700, 200),
    item("KEEPER", 180, 630),
  ]);
  expect(text.split("\n")[0]).toBe("7 EXT. PARK - DAY 7");
  expect(parseScreenplay(text)[0]).toMatchObject({
    number: "7",
    time: "DAY",
    characters: ["KEEPER"],
  });
});
test("saving cannot orphan source files or pretend edited text retains the original page mapping", () => {
  const p = sourceProject();
  expect(
    saveSchema.safeParse({ project: { ...p, assets: [] }, revision: 0 })
      .success,
  ).toBe(false);
  expect(
    saveSchema.safeParse({
      project: { ...p, script: "different" },
      revision: 0,
    }).success,
  ).toBe(false);
  expect(
    saveSchema.safeParse({
      project: {
        ...p,
        script: "different",
        scriptSource: { ...p.scriptSource, edited: true },
      },
      revision: 0,
    }).success,
  ).toBe(true);
});


test("project JSON admission counts UTF-8 bytes and stops an oversized chunked body before reading its tail", async () => {
  let reads = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(1_000_000).fill(97));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await readProjectBody(
    new Request("http://localhost/api/workbench/projects", {
      method: "PUT",
      body: stream,
      duplex: "half",
    } as RequestInit),
  );
  expect(result).toMatchObject({ ok: false, status: 413 });
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(5);
  /* 1.4 million characters, 4.2 MB of UTF-8: over the 4 MB uncompressed limit by bytes, not characters. */
  const unicode = JSON.stringify({ script: "漢".repeat(1_400_000) });
  expect(
    await readProjectBody(
      new Request("http://localhost", { method: "PUT", body: unicode }),
    ),
  ).toMatchObject({ ok: false, status: 413 });
  expect(
    await readProjectBody(
      new Request("http://localhost", {
        method: "PUT",
        body: JSON.stringify({ script: "complete source" }),
      }),
    ),
  ).toEqual({ ok: true, value: { script: "complete source" } });
});
