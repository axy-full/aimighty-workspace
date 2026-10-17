import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { extractDocument } from "../../lib/docImport/extract";
import { detectDocument } from "../../lib/docImport/detect";
import {
  MAX_CELLS,
  MAX_COLUMNS,
  MAX_DOCX_XML_EVENTS,
  MAX_IMAGES,
  MAX_PDF_PAGES,
  MAX_SHEETS,
  MAX_SLIDES,
  MAX_SOURCE_BYTES,
  MAX_TEXT_CHARS,
  MAX_XML_EVENTS,
  MAX_XML_PART_BYTES,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
} from "../../lib/docImport/limits";
import { openZip, resolvePartPath } from "../../lib/docImport/zip";
import { scanXml } from "../../lib/docImport/xml";
import { DocImportError, type DocImportErrorCode } from "../../lib/docImport/types";
import { ocrDataDir, tesseractWorkerOptions, type OcrEngine } from "../../lib/docImport/image";
import {
  compoundFile,
  declaredPng,
  deflateBomb,
  docx,
  fdx,
  overlappingZip,
  para,
  pdf,
  pptx,
  prose,
  lowEntropy,
  textPng,
  textTiff,
  tiff,
  xlsx,
  zip,
} from "../helpers/docImportFixtures";

/**
 * The document importer's extractors (v30 Phase A item 2, part 1): every
 * format to the one normalized shape, and every hostile input refused with a
 * plain DocImportError before it can cost memory, time or a file read.
 * Every fixture is synthetic and built here. No model is called; the OCR
 * engine is a fake except in the tests that run the real one on generated
 * pictures. Each limit has a test that fails if the limit is removed.
 */

async function refused(promise: Promise<unknown>, code: DocImportErrorCode): Promise<DocImportError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected a refusal with code ${code}`).toBeInstanceOf(DocImportError);
  expect((error as DocImportError).code).toBe(code);
  expect((error as DocImportError).message).toMatch(/\.$/);
  return error as DocImportError;
}

const fakeOcr = (text: string, confidence = 91): OcrEngine => async () => ({ text, confidence });

/* ── Formats ─────────────────────────────────────────────────────────── */

test("a .docx comes back as plain text through mammoth, with its embedded picture typed from its bytes", async () => {
  const picture = textPng("HELLO", 2);
  const doc = await extractDocument("Brief.docx", docx(["A coffee brand film.", "Thirty seconds, warm light."], { image: picture }));
  expect(doc.kind).toBe("docx");
  expect(doc.format).toBe("plain");
  expect(doc.text).toContain("A coffee brand film.");
  expect(doc.text).toContain("Thirty seconds, warm light.");
  expect(doc.sections).toEqual([{ kind: "document", index: 1, start: 0, end: doc.text.length }]);
  expect(doc.images).toHaveLength(1);
  expect(doc.images[0]).toMatchObject({ name: "image1.png", mime: "image/png", ext: "png" });
  expect(doc.images[0].bytes.equals(picture)).toBe(true);
});

test("a .pdf's text layer is read page by page, and a page with no text is named in a warning", async () => {
  const doc = await extractDocument("treatment.pdf", pdf(["Opening on the harbour at dawn", "Close on the cup", ""]));
  expect(doc.kind).toBe("pdf");
  expect(doc.sections.map((s) => [s.kind, s.index])).toEqual([["page", 1], ["page", 2], ["page", 3]]);
  const page = (n: number) => doc.text.slice(doc.sections[n].start, doc.sections[n].end);
  expect(page(0)).toBe("Opening on the harbour at dawn");
  expect(page(1)).toBe("Close on the cup");
  expect(doc.warnings.join(" ")).toMatch(/Pages 3 have little or no text/);
});

test("a Final Draft file becomes Fountain: headings, numbers, characters, parentheticals, dual dialogue, transitions, emphasis", async () => {
  const content = [
    para("Scene Heading", "INT. KITCHEN - DAY", ' Number="12"'),
    para("Action", "Maya pours the coffee. It *steams*."),
    para("Action", "SILENCE."),
    para("Character", "MAYA"),
    para("Parenthetical", "quietly"),
    para("Dialogue", "Just one more."),
    `<Paragraph><DualDialogue>${para("Character", "LEO")}${para("Dialogue", "No.")}${para("Character", "Ana")}${para("Dialogue", "Yes.")}</DualDialogue></Paragraph>`,
    `<Paragraph Type="Action"><Text Style="Bold">Loud</Text><Text> and </Text><Text Style="Italic+Underline">clear</Text></Paragraph>`,
    para("Transition", "CUT TO:"),
    para("Transition", "Fade out"),
    para("Scene Heading", "Rooftop - night"),
    para("Action", "INT. is written in the action here."),
  ].join("");
  const doc = await extractDocument("pilot.fdx", fdx(content));
  expect(doc.kind).toBe("fdx");
  expect(doc.format).toBe("fountain");
  expect(doc.text).toBe(
    [
      "INT. KITCHEN - DAY #12#",
      "Maya pours the coffee. It \\*steams\\*.",
      "!SILENCE.",
      "MAYA\n(quietly)\nJust one more.",
      "LEO\nNo.",
      "@Ana ^\nYes.",
      "**Loud** and *_clear_*",
      "CUT TO:",
      "> Fade out",
      ".Rooftop - night",
      "!INT. is written in the action here.",
    ].join("\n\n") + "\n",
  );
  expect(doc.text).not.toContain("TITLE PAGE TEXT");
  expect(doc.sections.map((s) => s.title)).toEqual(["INT. KITCHEN - DAY", "Rooftop - night"]);
  expect(doc.text.slice(doc.sections[1].start, doc.sections[1].end)).toBe(".Rooftop - night\n\n!INT. is written in the action here.");
  expect(doc.text.slice(doc.sections[0].start, doc.sections[0].end).endsWith("> Fade out")).toBe(true);
});

test("a .fdxt template reads like a .fdx", async () => {
  const doc = await extractDocument("template.fdxt", fdx(para("Scene Heading", "EXT. FIELD - DAY")));
  expect(doc.text).toBe("EXT. FIELD - DAY\n");
});

test("a .pptx gives each slide's text with its speaker notes in deck order, and lists its pictures", async () => {
  const picture = textPng("HELLO", 2);
  const doc = await extractDocument("pitch.pptx", pptx(
    [{ paragraphs: ["The idea", "One cup, one city"], notes: ["Say this slowly."] }, { paragraphs: ["Budget"] }],
    { images: [{ name: "image1.png", data: picture }, { name: "image2.emf", data: Buffer.from("not a raster picture at all, just bytes") }] },
  ));
  expect(doc.kind).toBe("pptx");
  expect(doc.sections.map((s) => [s.kind, s.index, s.title])).toEqual([["slide", 1, "The idea"], ["slide", 2, "Budget"]]);
  expect(doc.text.slice(doc.sections[0].start, doc.sections[0].end)).toBe("The idea\nOne cup, one city\n\nNotes:\nSay this slowly.");
  expect(doc.images.map((i) => [i.name, i.mime])).toEqual([["image1.png", "image/png"]]);
  expect(doc.warnings.join(" ")).toMatch(/1 embedded files are in formats the importer does not keep/);
});

test("a .xlsx gives each sheet as tab-separated rows of its values, hidden sheets named in a warning", async () => {
  const doc = await extractDocument("schedule.xlsx", xlsx([
    { name: "Shots", rows: [["Shot", "Lens", "Seconds"], ["Wide", "24mm", 5], ["Close", "", 3]] },
    { name: "Crew", rows: [["Name"], ["Producer"]], hidden: true },
  ]));
  expect(doc.kind).toBe("xlsx");
  expect(doc.sections.map((s) => [s.kind, s.title])).toEqual([["sheet", "Shots"], ["sheet", "Crew"]]);
  expect(doc.text.slice(doc.sections[0].start, doc.sections[0].end)).toBe("Shot\tLens\tSeconds\nWide\t24mm\t5\nClose\t\t3");
  expect(doc.text.slice(doc.sections[1].start, doc.sections[1].end)).toBe("Name\nProducer");
  expect(doc.warnings.join(" ")).toMatch(/"Crew" is a hidden sheet/);
});

test("pictures go through the OCR engine with English by default; Hindi is an option the caller can ask for", async () => {
  const calls: string[][] = [];
  const ocr: OcrEngine = async (_image, { languages }) => {
    calls.push(languages);
    return { text: "SCENE ONE\n", confidence: 88 };
  };
  for (const name of ["scan.png", "scan.tiff"]) {
    const bytes = name.endsWith(".png") ? textPng("HELLO") : tiff(40, 20);
    const doc = await extractDocument(name, bytes, { ocr });
    expect(doc).toMatchObject({ kind: "image", text: "SCENE ONE", images: [] });
  }
  await extractDocument("scan.png", textPng("HELLO"), { ocr, languages: ["hin", "eng"] });
  expect(calls).toEqual([["eng"], ["eng"], ["hin", "eng"]]);
  const low = await extractDocument("scan.png", textPng("HELLO"), { ocr: fakeOcr("SOMETHING", 31) });
  expect(low.warnings.join(" ")).toMatch(/OCR confidence is low \(31%\)/);
});

test("the real Tesseract engine reads generated PNG and TIFF pictures from the installed English data", async () => {
  test.setTimeout(60_000);
  expect((await extractDocument("card.png", textPng("HELLO WORLD"))).text).toContain("HELLO");
  expect((await extractDocument("card.tiff", textTiff("HELLO WORLD"))).text).toContain("HELLO");
});

test("OCR data comes from a local absolute directory only, with no cache and no logging; anything URL-shaped is refused", () => {
  const dir = ocrDataDir({});
  expect(dir).toMatch(/node_modules\/@tesseract\.js-data\/eng\/4\.0\.0_best_int$/);
  expect(existsSync(`${dir}/eng.traineddata.gz`)).toBe(true);
  for (const bad of ["https://cdn.example/tessdata", "http://x", "file:///tmp/x", "//cdn.example/tessdata", "relative/dir", "C:\\data"])
    expect(() => ocrDataDir({ DOC_IMPORT_OCR_DATA_DIR: bad }), bad).toThrow(/OCR is not set up/);
  expect(ocrDataDir({ DOC_IMPORT_OCR_DATA_DIR: "/srv/ocr/" })).toBe("/srv/ocr");
  expect(tesseractWorkerOptions(dir)).toMatchObject({ langPath: dir, cacheMethod: "none", gzip: true });
  expect(Object.keys(tesseractWorkerOptions(dir)).sort()).toEqual(["cacheMethod", "errorHandler", "gzip", "langPath", "logger"]);
});

test("a TIFF that names its width or height twice is refused before OCR", async () => {
  let called = false;
  const ocr: OcrEngine = async () => {
    called = true;
    return { text: "x", confidence: 99 };
  };
  await refused(extractDocument("two.tiff", tiff(40, 20, { width: 40_000, height: 40_000 }), { ocr }), "unsafe");
  expect(called).toBe(false);
});

test("the real Tesseract engine refuses a truncated picture as damaged, without hanging", async () => {
  test.setTimeout(60_000);
  const picture = textPng("HELLO WORLD");
  await refused(extractDocument("cut.png", picture.subarray(0, Math.floor(picture.length * 0.6)), { timeoutMs: 30_000 }), "damaged");
});

test("Hindi OCR is refused as not installed (never downloaded) until its data is on disk", async () => {
  await refused(extractDocument("card.png", textPng("HELLO"), { languages: ["hin"] }), "language_unavailable");
});

test("an SVG gives its <text> nodes only", async () => {
  const doc = await extractDocument("frame.svg", Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="10">Title <tspan>card</tspan></text><g><text>Second line</text></g></svg>`,
  ));
  expect(doc).toMatchObject({ kind: "svg", text: "Title card\nSecond line", warnings: [] });
});

/* ── Hostile and broken inputs ───────────────────────────────────────── */

test("zip bomb: an entry that expands past the ratio limit is refused from the directory, before anything inflates", async () => {
  const bomb = Buffer.alloc(8 * 1024 * 1024, 0x20);
  const bytes = docx(["x"], { extra: [{ name: "word/bomb.xml", data: bomb }] });
  expect(bytes.length).toBeLessThan(100_000);
  const error = await refused(extractDocument("bomb.docx", bytes), "unsafe");
  expect(error.message).toMatch(/expands far more than a real document/);
});

test("zip bomb: a part that declares 100 bytes but inflates to 1 GB stops at 100 bytes, refused at once", async () => {
  // A raw deflate stream for 1 GiB of zeros (6.7 MB). Without maxOutputLength it inflates for over a second into a 1 GB buffer.
  const bomb = deflateBomb(2 ** 30);
  const lie = docx(["x"], { extra: [{ name: "word/styles.xml", data: "", rawBody: bomb, declaredSize: 100, crc: 0 }] });
  const started = Date.now();
  await refused(extractDocument("lie.docx", lie), "damaged");
  expect(Date.now() - started).toBeLessThan(400);
});

test("zip: an entry declared past the entry limit, Zip64 sizes and unknown compression methods are refused from the directory", async () => {
  expect((await refused(extractDocument("big.docx", zip([{ name: "word/document.xml", data: "x", declaredSize: MAX_ZIP_ENTRY_BYTES + 1, rawMethod: 0 }])), "limit")).message)
    .toMatch(/a part larger than the importer reads/);
  await refused(extractDocument("z64.docx", zip([{ name: "word/document.xml", data: "x", declaredSize: 0xffffffff }])), "unsupported");
  await refused(extractDocument("bz2.docx", zip([{ name: "word/document.xml", data: "x", rawMethod: 12 }])), "unsupported");
});

test("zip: an XML part past its own limit is refused when read, even stored uncompressed", async () => {
  const slide = Buffer.alloc(MAX_XML_PART_BYTES + 1, 0x20);
  const error = await refused(
    extractDocument("big.pptx", zip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "ppt/presentation.xml", data: slide, method: 0 },
    ])),
    "limit",
  );
  expect(error.message).toMatch(/a part larger than the importer reads/);
});

test("zip bomb: a directory whose declared total passes the limit is refused before any part is read", async () => {
  const entries = Array.from({ length: 300 }, (_, i) => ({ name: `ppt/media/f${i}.bin`, data: "x", declaredSize: 1024 * 1024 }));
  const error = await refused(extractDocument("huge.pptx", zip(entries)), "limit");
  expect(error.message).toMatch(/expands past the importer's size limit/);
});

test("zip bomb: more entries than the limit is refused", async () => {
  const entries = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `e${i}`, data: "", method: 0 as const }));
  const error = await refused(extractDocument("many.xlsx", zip(entries)), "limit");
  expect(error.message).toMatch(/more than 5000 parts/);
});

test("zip bomb: two parts that share the same compressed bytes (overlapping files) are refused", async () => {
  expect(() => openZip(overlappingZip("a.xml", "b.xml", "<a/>"), "This package")).toThrow(/reuses the same data/);
});

test("a password-protected Office file (a compound file under an Office extension) is refused as encrypted", async () => {
  for (const name of ["locked.docx", "locked.pptx", "locked.xlsx"])
    expect((await refused(extractDocument(name, compoundFile()), "encrypted")).message).toMatch(/password protected/);
});

test("a zip entry with zip's own encryption flag, and a duplicate or path-like part name, are refused", async () => {
  await refused(extractDocument("zipcrypto.docx", zip([{ name: "word/document.xml", data: "<a/>", flags: 1 }])), "encrypted");
  await refused(extractDocument("twice.docx", zip([{ name: "a.xml", data: "<a/>" }, { name: "a.xml", data: "<a/>" }])), "unsafe");
  await refused(extractDocument("escape.docx", zip([{ name: "../../etc/passwd", data: "x" }])), "unsafe");
});

const XXE = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>`;
const LAUGHS = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"><!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">]>`;

test("XXE: a DOCTYPE with an external entity is refused in Word, deck, workbook and Final Draft files", async () => {
  await refused(extractDocument("x.docx", docx([], { documentXml: `${XXE}<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>` })), "unsafe");
  await refused(extractDocument("x.pptx", pptx([{ paragraphs: [] }], { slideXml: `${XXE}<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:t>&xxe;</a:t></a:p></p:sld>` })), "unsafe");
  await refused(extractDocument("x.xlsx", xlsx([{ name: "S", rows: [["a"]] }], { sharedStringsXml: `${XXE}<sst><si><t>&xxe;</t></si></sst>` })), "unsafe");
  const fd = Buffer.from(`${XXE}<FinalDraft><Content>${para("Action", "x").replace("<Text>x", "<Text>&xxe;")}</Content></FinalDraft>`);
  await refused(extractDocument("x.fdx", fd), "unsafe");
});

test("billion laughs: refused in a Final Draft file; in an SVG the DOCTYPE is stepped over and nothing expands", async () => {
  await refused(extractDocument("lol.fdx", Buffer.from(`${LAUGHS}<FinalDraft><Content>${para("Action", "&lol9;")}</Content></FinalDraft>`)), "unsafe");
  const started = Date.now();
  const doc = await extractDocument("lol.svg", Buffer.from(`${LAUGHS}<svg><text>&lol9;</text></svg>`));
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(doc.text).toBe("&lol9;");
  expect(doc.warnings.join(" ")).toMatch(/declares a document type; it was not read/);
  expect(doc.warnings.join(" ")).toMatch(/1 entity references the importer does not expand/);
});

test("XXE in an SVG: the external entity is never resolved and no file is read", async () => {
  const doc = await extractDocument("x.svg", Buffer.from(`${XXE.replace("foo", "svg")}<svg><text>&xxe;</text></svg>`));
  expect(doc.text).toBe("&xxe;");
  expect(doc.text).not.toContain("root:");
});

test("an SVG's script, foreignObject, styles and external references are never run, followed or read", async () => {
  const before = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network");
  }) as typeof fetch;
  try {
    const doc = await extractDocument("evil.svg", Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">` +
        `<script>window.stolen = "secret"; fetch("https://attacker.invalid/")</script>` +
        `<style>@import url(https://attacker.invalid/x.css);</style>` +
        `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hidden html</div></foreignObject>` +
        `<image href="https://attacker.invalid/p.png"/><use xlink:href="https://attacker.invalid/s.svg#t"/>` +
        `<text>Visible<script>inner()</script></text></svg>`,
    ));
    expect(doc.text).toBe("Visible");
    expect(fetched).toBe(0);
    expect((globalThis as { stolen?: string }).stolen).toBeUndefined();
  } finally {
    globalThis.fetch = before;
  }
});

test("an oversized file is refused before it is read", async () => {
  await refused(extractDocument("big.svg", Buffer.alloc(MAX_SOURCE_BYTES.svg + 1, 0x20)), "too_large");
  await refused(extractDocument("big.fdx", Buffer.alloc(MAX_SOURCE_BYTES.fdx + 1, 0x20)), "too_large");
});

test("a picture inside the side limit but past the area limit (10,000 × 10,000) is refused; so is one past the side limit alone", async () => {
  let called = 0;
  const ocr: OcrEngine = async () => {
    called++;
    return { text: "", confidence: 0 };
  };
  expect((await refused(extractDocument("area.png", declaredPng(10_000, 10_000), { ocr }), "limit")).message).toMatch(/10000 × 10000 pixels/);
  expect((await refused(extractDocument("side.png", declaredPng(13_000, 10), { ocr }), "limit")).message).toMatch(/13000 × 10 pixels/);
  expect(called).toBe(0);
});

test("a picture whose header declares an enormous canvas is refused before OCR decodes it", async () => {
  let called = false;
  const ocr: OcrEngine = async () => {
    called = true;
    return { text: "", confidence: 0 };
  };
  const error = await refused(extractDocument("bomb.png", declaredPng(50_000, 50_000), { ocr }), "limit");
  expect(error.message).toMatch(/50000 × 50000 pixels/);
  expect(called).toBe(false);
});

test("extension and real type must agree; the refusal names what the file really is", async () => {
  const pdfBytes = pdf(["x"]);
  expect((await refused(extractDocument("photo.png", pdfBytes), "type_mismatch")).message).toMatch(/named \.png but it is a PDF/);
  expect((await refused(extractDocument("deck.pptx", docx(["x"])), "type_mismatch")).message).toMatch(/named \.pptx but it is a Word document/);
  expect((await refused(extractDocument("photo.jpg", textPng("HELLO")), "type_mismatch")).message).toMatch(/named \.jpg but it is a PNG image/);
  expect((await refused(extractDocument("brief.pdf", docx(["x"])), "type_mismatch")).message).toMatch(/named \.pdf but it is a zip package/);
  await refused(extractDocument("script.fdx", Buffer.from("<html><body>hi</body></html>")), "type_mismatch");
  await refused(extractDocument("art.svg", Buffer.from("<FinalDraft><Content/></FinalDraft>")), "type_mismatch");
  await refused(extractDocument("brief.doc", Buffer.from("x")), "unsupported");
  await refused(extractDocument("run.exe", Buffer.from("MZ")), "unsupported");
  expect(detectDocument("Brief.DOCX", docx(["x"])).kind).toBe("docx");
});

test("truncated files are refused as damaged", async () => {
  const half = (bytes: Buffer) => bytes.subarray(0, Math.floor(bytes.length / 2));
  await refused(extractDocument("cut.docx", half(docx(["Some text to cut in half."]))), "damaged");
  await refused(extractDocument("cut.xlsx", half(xlsx([{ name: "S", rows: [["a"]] }]))), "damaged");
  await refused(extractDocument("cut.pdf", half(pdf(["Some text"]))), "damaged");
  await refused(extractDocument("cut.fdx", half(fdx(para("Action", "A long line of action to cut through.")))), "damaged");
  await refused(extractDocument("cut.svg", Buffer.from("<svg><text>open")), "damaged");
});

test("the per-file timeout ends an extraction that does not finish", async () => {
  const never: OcrEngine = () => new Promise(() => {});
  const started = Date.now();
  await refused(extractDocument("slow.png", textPng("HELLO"), { ocr: never, timeoutMs: 300 }), "timeout");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("the XML scanner keeps attribute names as data and never expands custom entities", () => {
  const seen: Record<string, string>[] = [];
  const result = scanXml(`<a __proto__="x" constructor="y">&custom; &amp; &#x41;&#66;</a>`, (event) => {
    if (event.type === "open") seen.push(event.attrs);
    if (event.type === "text") expect(event.text).toBe("&custom; & AB");
  }, { doctype: "refuse" });
  expect(result.unknownEntities).toBe(1);
  expect(Object.getPrototypeOf(seen[0])).toBeNull();
  expect(seen[0].__proto__).toBe("x");
  expect(({} as { x?: string }).x).toBeUndefined();
  expect(() => scanXml("<a><b></a>", () => {}, { doctype: "refuse" })).toThrow(/damaged/);
  expect(() => scanXml(`<a>${"<b>".repeat(300)}`, () => {}, { doctype: "refuse" })).toThrow(/nested deeper/);
});

test("a deflate stream that is not valid is refused as damaged, never thrown raw", async () => {
  const good = docx(["Some words to compress."]);
  const entry = openZip(good, "This package").entries.get("word/document.xml")!;
  const broken = Buffer.from(good);
  // Same sizes, same CRC in the directory; the compressed bytes themselves are garbage.
  broken.fill(0xff, entry.dataStart, entry.dataStart + entry.compressedSize);
  await refused(extractDocument("broken.docx", broken), "damaged");
});

/* ── Every limit, past its edge ──────────────────────────────────────── */

const over = prose(MAX_TEXT_CHARS + 10);

test("the one-million-character limit refuses in every format that can produce that much text", async () => {
  await refused(extractDocument("long.fdx", fdx(para("Action", over))), "limit");
  await refused(extractDocument("long.svg", Buffer.from(`<svg><text>${over}</text></svg>`)), "limit");
  await refused(extractDocument("long.docx", docx([over])), "limit");
  await refused(extractDocument("long.pptx", pptx([{ paragraphs: [over] }])), "limit");
  await refused(extractDocument("long.xlsx", xlsx([{ name: "S", rows: Array.from({ length: 40 }, (_, r) => [prose(30_000, r + 1)]) }])), "limit");
  await refused(extractDocument("long.png", textPng("HELLO"), { ocr: fakeOcr(over) }), "limit");
});

test("workbook amplification: one 1M-character shared string is refused as a cell longer than Excel allows, at once", async () => {
  const huge = "z".repeat(1_000_000);
  const bytes = xlsx([{ name: "S", rows: Array.from({ length: 50 }, () => Array.from({ length: 100 }, () => huge)) }]);
  const started = Date.now();
  expect((await refused(extractDocument("amp.xlsx", bytes), "limit")).message).toMatch(/longer than 32767 characters/);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("workbook amplification: a 30,000-character string in 5,000 cells (150M characters) is refused by the running count, at once", async () => {
  const long = "z".repeat(30_000);
  const bytes = xlsx([{ name: "S", rows: Array.from({ length: 50 }, () => Array.from({ length: 100 }, () => long)) }]);
  const started = Date.now();
  expect((await refused(extractDocument("amp.xlsx", bytes), "limit")).message).toMatch(/more than one million characters/);
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("slide, sheet, cell and PDF page counts past their limits are refused; a column past its limit is skipped with a warning", async () => {
  await refused(extractDocument("many.pptx", pptx(Array.from({ length: MAX_SLIDES + 1 }, () => ({ paragraphs: ["a"] })))), "limit");
  await refused(extractDocument("many.xlsx", xlsx(Array.from({ length: MAX_SHEETS + 1 }, (_, i) => ({ name: `S${i}`, rows: [["a"]] })))), "limit");
  await refused(extractDocument("cells.xlsx", xlsx([{ name: "S", rows: Array.from({ length: MAX_CELLS / 100 + 1 }, () => Array.from({ length: 100 }, () => 1)) }])), "limit");
  await refused(extractDocument("pages.pdf", pdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => "p"))), "limit");
  const wide = await extractDocument("wide.xlsx", xlsx([{ name: "S", rows: [[...Array.from({ length: MAX_COLUMNS }, () => ""), "far right"], ["near"]] }]));
  expect(wide.text).toBe("near");
  expect(wide.warnings.join(" ")).toMatch(/cells past column 256/);
});

test("embedded pictures past the count limit, or past the total-size limit, are skipped with a warning", async () => {
  test.setTimeout(60_000);
  const small = textPng("HELLO", 1);
  const many = await extractDocument("pics.pptx", pptx([{ paragraphs: ["a"] }], { images: Array.from({ length: MAX_IMAGES + 1 }, (_, i) => ({ name: `i${String(i).padStart(3, "0")}.png`, data: small })) }));
  expect(many.images).toHaveLength(MAX_IMAGES);
  expect(many.warnings.join(" ")).toMatch(/Only the first 200 embedded pictures were kept/);
  // Five 21 MB pictures: 105 MB, past the 100 MB total. The first four are kept. (Compressed about 4:1, so the deck stays under 50 MB.)
  const big = Buffer.concat([small, lowEntropy(21 * 1024 * 1024)]);
  const heavy = await extractDocument("heavy.pptx", pptx([{ paragraphs: ["a"] }], { images: Array.from({ length: 5 }, (_, i) => ({ name: `b${i}.png`, data: big, deflate: true })) }));
  expect(heavy.images).toHaveLength(4);
  expect(heavy.warnings.join(" ")).toMatch(/Only the first 4 embedded pictures were kept/);
});

test("XML structure past the event limit is refused: 5M events in a slide, and 2M across the parts mammoth would read", async () => {
  test.setTimeout(60_000);
  const events = (n: number) => "<a:br/>".repeat(Math.ceil(n / 2));
  const P = 'xmlns:a="a" xmlns:p="p"';
  expect((await refused(extractDocument("deep.pptx", pptx([{ paragraphs: [] }], { stored: true, slideXml: `<p:sld ${P}>${events(MAX_XML_EVENTS + 2)}</p:sld>` })), "limit")).message)
    .toMatch(/more structure than the importer reads/);
  const W = 'xmlns:w="w"';
  const doc = `<w:document ${W}><w:body><w:p>${"<w:r/>".repeat(MAX_DOCX_XML_EVENTS / 2 + 1)}</w:p></w:body></w:document>`;
  expect((await refused(extractDocument("deep.docx", docx([], { documentXml: doc, stored: true })), "limit")).message).toMatch(/more structure than the importer reads/);
});

test("relationship targets outside the package, or marked External, are never followed", async () => {
  expect(resolvePartPath("ppt/slides", "../../../etc/passwd")).toBeNull();
  expect(resolvePartPath("ppt/slides", "%2e%2e/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  expect(resolvePartPath("ppt/slides", "https://attacker.invalid/x.xml")).toBeNull();
  expect(resolvePartPath("ppt/slides", "file:///etc/passwd")).toBeNull();
  expect(resolvePartPath("ppt/slides", "..\\..\\x")).toBeNull();
  expect(resolvePartPath("ppt/slides", "../notesSlides/n1.xml")).toBe("ppt/notesSlides/n1.xml");
  expect(resolvePartPath("ppt/slides", "/ppt/media/a.png")).toBe("ppt/media/a.png");
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const doc = await extractDocument("links.pptx", pptx([{ paragraphs: ["Slide"] }], {
    order: [1, 7, 8],
    presentationRels: `<Relationship Id="rId7" Type="${REL}/slide" Target="../../../../etc/passwd"/><Relationship Id="rId8" Type="${REL}/slide" Target="https://attacker.invalid/s.xml" TargetMode="External"/>`,
    slide1Rels: `<Relationship Id="rIdX" Type="${REL}/notesSlide" Target="https://attacker.invalid/n.xml" TargetMode="External"/>`,
  }));
  expect(doc.text).toBe("Slide");
  expect(doc.warnings.join(" ")).toMatch(/missing and was skipped/);
  expect(doc.warnings.join(" ")).toMatch(/links to something outside the file; it was not followed/);
});

test("a deck with 8,000 notes relationships on one slide reads its notes once, at once", async () => {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const rels = Array.from({ length: 8_000 }, (_, i) => `<Relationship Id="rN${i}" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`).join("");
  const started = Date.now();
  const doc = await extractDocument("fan.pptx", pptx([{ paragraphs: ["Slide"], notes: ["Say it once. ".repeat(5_000)] }], { slide1Rels: rels }));
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(doc.text.match(/Notes:/g)).toHaveLength(1);
});

test("a slide or sheet listed twice is read once", async () => {
  const deck = await extractDocument("twice.pptx", pptx([{ paragraphs: ["One"] }, { paragraphs: ["Two"] }], { order: [1, 2, 1, 1] }));
  expect(deck.sections.map((s) => s.title)).toEqual(["One", "Two"]);
  expect(deck.warnings.join(" ")).toMatch(/listed twice by the presentation was read once/);
  const book = await extractDocument("twice.xlsx", xlsx([{ name: "A", rows: [["a"]] }, { name: "B", rows: [["b"]], rid: 1 }]));
  expect(book.sections.map((s) => s.title)).toEqual(["A"]);
  expect(book.warnings.join(" ")).toMatch(/listed twice by the workbook was read once/);
});

test("the deadline also stops synchronous parsing: a clock past the limit ends a workbook read between XML chunks", async () => {
  let now = 0;
  const clock = () => (now += 1_000);
  const bytes = xlsx([{ name: "S", rows: Array.from({ length: 1_000 }, (_, r) => Array.from({ length: 50 }, (_, c) => r * c)) }]);
  const started = Date.now();
  await refused(extractDocument("slow.xlsx", bytes, { clock, timeoutMs: 20_000 }), "timeout");
  // The real-time timer (20 s) never fired: the synchronous checks did it.
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("mammoth's own warnings, which quote style names, are never passed on", async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const doc = `<w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="ClientSecretStyle"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:unknownThing/><w:t>There</w:t></w:r></w:p></w:body></w:document>`;
  const result = await extractDocument("styles.docx", docx([], { documentXml: doc }));
  expect(result.text).toContain("Hello");
  expect(result.warnings.join(" ")).not.toMatch(/ClientSecretStyle|unknownThing/);
  for (const warning of result.warnings) expect(warning).toMatch(/^(Some Word formatting was not recognised; the text was kept\.)$/);
});

test("a hostile PDF is bounded at least by the page limit (decoded streams are not bounded in-process; see the PR)", async () => {
  await refused(extractDocument("pages.pdf", pdf(Array.from({ length: MAX_PDF_PAGES + 1 }, (_, i) => `page ${i}`))), "limit");
});
