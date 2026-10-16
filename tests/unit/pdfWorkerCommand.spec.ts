import { test, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { chromeArgs, findChromeHeadlessShell, runPdf, type ChromeRunner } from "../../remotion/node/pdf";
import { PDF_CSP, PDF_FONTS, imageKindOf, type PdfSpec } from "../../remotion/src/lib/pdf";
import { ppmDoc, pitchDoc, treatmentDoc } from "../../lib/pdf/builders";
import { deckHtml } from "../../lib/pdf/html";
import type { DeckDoc } from "../../lib/pdf/deck";
import { fakePdf } from "./remotionWorkerFake";

/* The PDF half of the worker's fixed command (remotion/node/pdf.ts): the page is checked, the browser is started with fixed flags and no
   way out, and what it writes is checked before it is kept. A stand-in browser here; one test prints for real with the Chrome Headless Shell
   when this machine has one (the unit suite's browsers), and measures that no page overflows. Nothing is sent anywhere. */

const FONTS = path.resolve("remotion/public/fonts");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
const dirs = () => {
  const root = mkdtempSync(path.join(tmpdir(), "pdf-worker-"));
  for (const d of ["input", "output", "work"]) mkdirSync(path.join(root, d));
  return { root, input: path.join(root, "input"), output: path.join(root, "output"), work: path.join(root, "work") };
};
const docOf = (): DeckDoc => pitchDoc({ title: "Deck", sections: [{ heading: "One", paragraphs: ["Words."] }, { heading: "Two", bullets: ["a"] }] }, { date: "15 Oct 2026", size: "a4" });
const specOf = (doc: DeckDoc, images: string[] = []): PdfSpec => ({ version: 1, composition: "pdf", pdf: { pages: doc.pages.length, trimMm: { width: 297, height: 210 }, bleedMm: 0, images } });
/** A stand-in for the browser: records what it was asked and writes the PDF it was told to. */
const standIn = (make: (args: string[]) => Buffer | null, code = 0) => {
  const calls: { executable: string; args: string[] }[] = [];
  const run: ChromeRunner = async (executable, args) => {
    calls.push({ executable, args });
    const target = args.find((a) => a.startsWith("--print-to-pdf="))!.slice("--print-to-pdf=".length);
    const pdf = make(args);
    if (pdf) writeFileSync(target, pdf);
    return { code, timedOut: false, stderr: "" };
  };
  return { run, calls };
};
const setup = (doc: DeckDoc, files: Record<string, Buffer> = {}) => {
  const d = dirs();
  writeFileSync(path.join(d.input, "deck.html"), deckHtml(doc));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(path.join(d.input, name), bytes);
  return d;
};
const base = (d: ReturnType<typeof dirs>, spec: unknown, run: ChromeRunner, extra: Record<string, unknown> = {}) =>
  runPdf({ spec, inputDir: d.input, outputDir: d.output, workDir: d.work, fontsDir: FONTS, chrome: "/opt/chrome", run, ...extra });

test("the browser is started with fixed flags: no name resolution, no remote control, one file, our fonts and pictures beside it", async () => {
  const doc = docOf();
  const d = setup(doc, { "i1.png": PNG });
  const stand = standIn(() => fakePdf(doc.pages.length, 297, 210));
  const result = await base(d, specOf(doc, ["i1.png"]), stand.run);
  expect(result).toMatchObject({ ok: true, pages: doc.pages.length, files: [{ name: "deck.pdf", kind: "pdf" }] });
  expect(stand.calls).toHaveLength(1);
  const { executable, args } = stand.calls[0];
  expect(executable).toBe("/opt/chrome");
  expect(args).toEqual(chromeArgs(d.work, path.join(d.work, "deck.pdf")));
  expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND");
  expect(args.filter((a) => /remote-debugging|--proxy|--enable-|--allow-file|--disable-web-security|--disable-site-isolation/.test(a))).toEqual([]);
  expect(args.at(-1)).toBe(`file://${path.join(d.work, "deck.html")}`);
  // The folder it prints from holds the page, the one picture and the typeface, and nothing else is copied in.
  expect(readdirSync(path.join(d.work, "assets"))).toEqual(["i1.png"]);
  expect(readdirSync(path.join(d.work, "fonts")).sort()).toEqual([...PDF_FONTS].sort());
  expect(readFileSync(path.join(d.work, "deck.html"), "utf8")).toContain(PDF_CSP);
  expect(readFileSync(path.join(d.output, "deck.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
});

test("a page that loads, runs or links is refused before any browser starts", async () => {
  const doc = docOf();
  for (const evil of ['<script>1</script>', '<img src="https://evil.test/x.png">', '<iframe src="x"></iframe>', "<a href=x>y</a>"]) {
    const d = dirs();
    writeFileSync(path.join(d.input, "deck.html"), deckHtml(doc).replace("<main>", `<main>${evil}`));
    const stand = standIn(() => fakePdf(doc.pages.length, 297, 210));
    const result = await base(d, specOf(doc), stand.run);
    expect(result).toMatchObject({ ok: false, code: "spec_invalid" });
    expect(stand.calls).toEqual([]);
  }
});

test("a bad spec, a missing page or picture, and a picture that is not what its name says are each refused, and no browser starts", async () => {
  const doc = docOf();
  const stand = standIn(() => fakePdf(doc.pages.length, 297, 210));
  expect(await base(setup(doc), { version: 1, composition: "pdf", pdf: { pages: 0 } }, stand.run)).toMatchObject({ ok: false, code: "spec_invalid" });
  expect(await base(dirs(), specOf(doc), stand.run)).toMatchObject({ ok: false, code: "input_missing" });
  expect(await base(setup(doc), specOf(doc, ["i1.png"]), stand.run)).toMatchObject({ ok: false, code: "input_missing" });
  expect(await base(setup(doc, { "i1.png": JPG }), specOf(doc, ["i1.png"]), stand.run)).toMatchObject({ ok: false, code: "input_mismatch" });
  expect(await base(setup(doc, { "i1.jpg": Buffer.from("not a picture") }), specOf(doc, ["i1.jpg"]), stand.run)).toMatchObject({ ok: false, code: "input_mismatch" });
  expect(await base(setup(doc, { "i1.png": PNG }), specOf(doc, ["i1.png"]), stand.run, { chrome: null })).toMatchObject({ ok: false, code: "render_failed" });
  expect(await base(setup(doc), specOf(doc), stand.run, { fontsDir: path.join(tmpdir(), "no-fonts-here") })).toMatchObject({ ok: false, code: "render_failed" });
  expect(stand.calls).toEqual([]);
  expect(imageKindOf(PNG)).toBe("png");
  expect(imageKindOf(JPG)).toBe("jpg");
  expect(imageKindOf(Buffer.from("RIFFxxxxWEBPVP8 "))).toBe("webp");
  expect(imageKindOf(Buffer.from("GIF89a"))).toBeNull();
});

test("what the browser writes is checked: it must be a PDF with the pages and the page size the spec promised", async () => {
  const doc = docOf();
  const cases: [string, () => Buffer | null, number][] = [
    ["no file", () => null, 0],
    ["not a PDF", () => Buffer.from("<html>no</html>"), 0],
    ["one page too many", () => fakePdf(doc.pages.length + 1, 297, 210), 0],
    ["the wrong page size", () => fakePdf(doc.pages.length, 279.4, 215.9), 0],
    ["a browser that failed", () => fakePdf(doc.pages.length, 297, 210), 1],
  ];
  for (const [name, make, code] of cases) {
    const d = setup(doc);
    const result = await base(d, specOf(doc), standIn(make, code).run);
    expect(result, name).toMatchObject({ ok: false, code: "render_failed" });
    expect(existsSync(path.join(d.output, "deck.pdf")), name).toBe(false);
  }
  // A bleed makes the page 6 mm larger each way, and that is what is checked.
  const bled = setup(doc);
  const spec = { ...specOf(doc), pdf: { ...specOf(doc).pdf, bleedMm: 3 } };
  expect((await base(bled, spec, standIn(() => fakePdf(doc.pages.length, 303, 216)).run)).ok).toBe(true);
  expect((await base(setup(doc), spec, standIn(() => fakePdf(doc.pages.length, 297, 210)).run)).ok).toBe(false);
  // A run that never ends is stopped, and says so.
  const d = setup(doc);
  const stuck: ChromeRunner = async () => ({ code: null, timedOut: true, stderr: "" });
  expect(await base(d, specOf(doc), stuck)).toMatchObject({ ok: false, code: "render_failed", errors: ["Printing took too long."] });
});

test("the browser is found where the image build put it", async () => {
  const runtime = mkdtempSync(path.join(tmpdir(), "pdf-runtime-"));
  expect(await findChromeHeadlessShell(runtime)).toBeNull();
  const where = path.join(runtime, "node_modules", ".remotion", "chrome-headless-shell", "linux64", "chrome-headless-shell-linux64");
  mkdirSync(where, { recursive: true });
  writeFileSync(path.join(where, "chrome-headless-shell"), "#!/bin/sh\n");
  expect(await findChromeHeadlessShell(runtime)).toBe(path.join(where, "chrome-headless-shell"));
});

/* ---- with a real browser ---- */

function headlessShell(): string | null {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(homedir(), ".cache", "ms-playwright")].filter((x): x is string => Boolean(x));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const candidate = path.join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (entry.startsWith("chromium_headless_shell") && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const worst = (): DeckDoc[] => {
  const long = "A sentence that keeps going and going, with words, and more words after those. ".repeat(40);
  const cell = "x".repeat(300);
  const sheet = { scriptSha256: "x", updatedAt: "", scenes: [{ id: "s", heading: "H", summary: "", beats: [], characters: ["A"], locations: ["L"], props: ["P"], shots: Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, description: cell, framing: cell, movement: cell, lighting: cell, sound: cell, duration: 5 })) }] };
  return [
    treatmentDoc({ title: "T".repeat(300), logline: "L".repeat(400), setup: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`key${i}`, cell])), scenes: Array.from({ length: 5 }, (_, i) => ({ n: i + 1, title: "S".repeat(200), secs: 9, prose: long })), draft: 1 }, { date: "15 Oct 2026", pictures: Array.from({ length: 11 }, (_, i) => ({ file: "i1.png", caption: cell + i })), logo: "i1.png" }),
    pitchDoc({ title: "P", sections: [{ heading: "H".repeat(200), paragraphs: [long, long], bullets: Array.from({ length: 24 }, () => "b".repeat(160)) }] }, { date: "15 Oct 2026", pictures: [{ file: "i1.png", caption: "c" }] }),
    ppmDoc({ name: "N", script: long.repeat(8), scriptVersions: [], nodes: [], boardShotList: {}, production: { beats: sheet } } as never, { date: "15 Oct 2026", pictures: [{ file: "i1.png", caption: "c" }], size: "a4" }),
    ppmDoc({ name: "N", script: "", scriptVersions: [], nodes: [], boardShotList: {}, production: { beats: sheet } } as never, { date: "15 Oct 2026", size: "letter", bleedMm: 3 }),
  ];
};

test("printed for real: each deck is a PDF of exactly its pages at its page size, and no page overflows or runs into its footer", async () => {
  const chrome = headlessShell();
  test.skip(!chrome, "no Chrome Headless Shell on this machine");
  test.setTimeout(240_000);
  const browser = await chromium.launch();
  try {
    for (const doc of worst()) {
      const d = dirs();
      const pictures = doc.images.length ? { "i1.png": PNG } : {};
      writeFileSync(path.join(d.input, "deck.html"), deckHtml(doc));
      for (const [name, bytes] of Object.entries(pictures)) writeFileSync(path.join(d.input, name), bytes);
      const size = doc.size === "slide" ? [338.667, 190.5] : doc.size === "a4" ? [297, 210] : [279.4, 215.9];
      // The spec the app sends names the page; the command's own check compares the PDF with it.
      const spec = { ...specOf(doc, doc.images), pdf: { ...specOf(doc, doc.images).pdf, trimMm: { width: size[0], height: size[1] }, bleedMm: doc.bleedMm } };
      const printed = await runPdf({ spec, inputDir: d.input, outputDir: d.output, workDir: d.work, fontsDir: FONTS, chrome: chrome! });
      expect(printed, `${doc.kind} ${doc.size}`).toMatchObject({ ok: true, pages: doc.pages.length });
      // Layout: the same page on screen, measured.
      const page = await browser.newPage();
      await page.goto(`file://${path.join(d.work, "deck.html")}`);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll<HTMLElement>(".page").forEach((el, i) => {
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) out.push(`page ${i + 1} overflows ${el.scrollHeight}/${el.clientHeight} ${el.scrollWidth}/${el.clientWidth}`);
          const foot = el.querySelector<HTMLElement>(".foot");
          if (!foot || getComputedStyle(foot).display === "none") return;
          const top = foot.getBoundingClientRect().top;
          const bottom = Math.max(...[...el.children].filter((c) => c !== foot).map((c) => c.getBoundingClientRect().bottom));
          if (bottom > top - 4) out.push(`page ${i + 1} runs into its footer by ${Math.round(bottom - top)} px`);
        });
        return out;
      });
      expect(bad, `${doc.kind} ${doc.size}`).toEqual([]);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
