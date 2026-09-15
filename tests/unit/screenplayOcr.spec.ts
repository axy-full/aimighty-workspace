import { test, expect } from "@playwright/test";
import {
  assemblePages,
  type ScreenplayImport,
} from "../../lib/workbench/screenplay";
import {
  requestOcr,
  applyOcrPage,
  remainingOcrPages,
  ocrReviewComplete,
  screenplayPage,
  editOcrPage,
  reviewOcrPage,
} from "../../lib/workbench/screenplay-ocr-state";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";
import { ScreenplayOcrWorker } from "../../lib/workbench/ocr-worker";
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
    "EXT. DOCK - NIGHT\nMARA\nA remembered moment.",
    94,
  );
}

test("mixed PDF OCR keeps untouched pages and original hash, replaces page offsets and cannot import partial work", () => {
  let result = recognized();
  expect(screenplayPage(result, 1)).toBe(screenplayPage(source(), 1));
  expect(result.sha256).toBe(source().sha256);
  expect(result.pages[2].start).toBe(result.pages[1].end);
  expect(result.emptyPages).toEqual([3]);
  expect(remainingOcrPages(result)).toEqual([3]);
  expect(ocrReviewComplete(result)).toBe(false);
  result = applyOcrPage(result, 3, "EXT. ROAD - DAWN\nAn open road.", 65);
  result = reviewOcrPage(reviewOcrPage(result, 2, true), 3, true);
  expect(ocrReviewComplete(result)).toBe(true);
  result = editOcrPage(result, 2, "EXT. DOCK - NIGHT\nCorrected dialogue.");
  expect(result.ocr?.pages[0]).toMatchObject({
    reviewed: false,
    corrected: true,
    confidence: 94,
  });
  expect(ocrReviewComplete(result)).toBe(false);
  expect(result.pages.at(-1)?.end).toBe(result.text.length);
});

test("OCR refuses invalid page selection, unrequested output, excessive text and invalid scores without shortening source", () => {
  for (const pages of [[], [0], [4], [1.5]])
    expect(() => requestOcr(source(), pages)).toThrow();
  const before = recognized();
  expect(() => applyOcrPage(before, 1, "Replaced without request", 99)).toThrow(
    /not requested/,
  );
  for (const confidence of [NaN, -1, 101])
    expect(() => applyOcrPage(before, 3, "Text", confidence)).toThrow(
      /confidence/,
    );
  expect(() => applyOcrPage(before, 3, "X".repeat(1_000_000), 99)).toThrow(
    /one million/,
  );
  expect(before).toEqual(recognized());
  expect(requestOcr(before, [2, 3, 3]).ocr?.requestedPages).toEqual([2, 3]);
});

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

class FakeWorker {
  static last: FakeWorker;
  messages: {
    workerId: string;
    jobId: string;
    action: string;
    payload: unknown;
  }[] = [];
  terminated = false;
  onmessage?: (event: unknown) => void;
  onerror?: (event: unknown) => void;
  constructor(public path: string) {
    FakeWorker.last = this;
  }
  postMessage(message: FakeWorker["messages"][number]) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  respond(data: unknown, status = "resolve") {
    this.onmessage?.({ data: { ...this.messages.at(-1), status, data } });
  }
}
async function fakeWorkerTest(run: () => Promise<void>) {
  const worker = Object.getOwnPropertyDescriptor(globalThis, "Worker"),
    location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "Worker", {
    value: FakeWorker,
    configurable: true,
  });
  Object.defineProperty(globalThis, "location", {
    value: { origin: "https://studio.example" },
    configurable: true,
  });
  try {
    await run();
  } finally {
    if (worker) Object.defineProperty(globalThis, "Worker", worker);
    else Reflect.deleteProperty(globalThis, "Worker");
    if (location) Object.defineProperty(globalThis, "location", location);
    else Reflect.deleteProperty(globalThis, "location");
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("cancel terminates the native worker during engine loading and rejects its pending startup", async () =>
  fakeWorkerTest(async () => {
    const abort = new AbortController();
    const worker = new ScreenplayOcrWorker(abort.signal, () => {});
    const initialization = worker.initialize();
    const rejected = expect(initialization).rejects.toThrow(/cancelled/);
    abort.abort();
    await rejected;
    expect(FakeWorker.last.terminated).toBe(true);
    expect(FakeWorker.last.messages).toHaveLength(1);
  }));

test("pinned worker protocol loads only local resources and preserves text; cancel during recognition rejects without later completion", async () =>
  fakeWorkerTest(async () => {
    const abort = new AbortController();
    const worker = new ScreenplayOcrWorker(abort.signal, () => {}),
      native = FakeWorker.last;
    const initialization = worker.initialize();
    for (const action of [
      "load",
      "loadLanguage",
      "initialize",
      "setParameters",
    ]) {
      expect(native.messages.at(-1)?.action).toBe(action);
      native.respond({});
      await tick();
    }
    await initialization;
    expect(JSON.stringify(native.messages)).not.toContain("cdn");
    expect(JSON.stringify(native.messages)).toContain(
      "https://studio.example/vendor/tesseract-7.0.0/eng-1.0.0",
    );
    const reading = worker.recognize(new Uint8Array([1, 2]));
    native.respond({ text: "INT. STATION - DAY\nAction.", confidence: 92 });
    await expect(reading).resolves.toMatchObject({
      confidence: 92,
      text: "INT. STATION - DAY\nAction.",
    });
    const next = worker.recognize(new Uint8Array([3]));
    const rejected = expect(next).rejects.toThrow(/cancelled/);
    abort.abort();
    await rejected;
    expect(native.terminated).toBe(true);
    native.respond({ text: "late", confidence: 99 });
  }));

test("worker initialization rejection propagates and terminates instead of waiting indefinitely", async () =>
  fakeWorkerTest(async () => {
    const worker = new ScreenplayOcrWorker(
      new AbortController().signal,
      () => {},
    );
    const pending = worker.initialize(),
      rejected = expect(pending).rejects.toThrow(/could not process/);
    FakeWorker.last.respond("network error", "reject");
    await rejected;
    expect(FakeWorker.last.terminated).toBe(true);
  }));

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

test("a stalled worker step times out, terminates and rejects without replaying the request", async () =>
  fakeWorkerTest(async () => {
    const original = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      if (delay === 60_000) expire = callback;
      return original(callback, delay);
    }) as typeof setTimeout;
    try {
      const worker = new ScreenplayOcrWorker(
        new AbortController().signal,
        () => {},
      );
      const pending = worker.initialize(),
        rejected = expect(pending).rejects.toThrow(/exceeded one minute/);
      expect(expire).toBeDefined();
      expire!();
      await rejected;
      expect(FakeWorker.last.terminated).toBe(true);
      expect(FakeWorker.last.messages).toHaveLength(1);
    } finally {
      globalThis.setTimeout = original;
    }
  }));
