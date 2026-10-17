import { test, expect } from "@playwright/test";
import { extractDocument } from "../../lib/docImport/extract";
import { detectDocument } from "../../lib/docImport/detect";
import { MAX_SOURCE_BYTES, MAX_ZIP_ENTRIES } from "../../lib/docImport/limits";
import { openZip } from "../../lib/docImport/zip";
import { scanXml } from "../../lib/docImport/xml";
import { DocImportError, type DocImportErrorCode } from "../../lib/docImport/types";
import type { OcrEngine } from "../../lib/docImport/image";
import { declaredPng, docx, fdx, overlappingZip, para, pdf, pptx, textPng, tiff, xlsx, zip } from "../helpers/docImportFixtures";

/**
 * The document importer's extractors (v30 Phase A item 2, part 1): every
 * format to the one normalized shape, and every hostile input refused with a
 * plain DocImportError before it can cost memory, time or a file read.
 * Every fixture is synthetic and built here. No model is called; the OCR
 * engine is a fake except in the two tests that prove the real one runs
 * offline.
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

test("the real Tesseract engine reads a generated picture offline, from the installed English data", async () => {
  test.setTimeout(60_000);
  const before = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in the importer");
  }) as typeof fetch;
  try {
    const doc = await extractDocument("card.png", textPng("HELLO WORLD"));
    expect(doc.text).toContain("HELLO");
    expect(fetched).toBe(0);
  } finally {
    globalThis.fetch = before;
  }
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

test("zip bomb: a part that lies about its size stops at the declared size and is refused as damaged", async () => {
  const lie = docx(["x"], { extra: [{ name: "word/styles.xml", data: Buffer.alloc(4 * 1024 * 1024, 0x20), declaredSize: 100 }] });
  const started = Date.now();
  await refused(extractDocument("lie.docx", lie), "damaged");
  expect(Date.now() - started).toBeLessThan(5_000);
  // The same lie inside a deck is refused the same way when the part is read.
  const archive = openZip(lie, "This package");
  expect(() => archive.read("word/styles.xml")).toThrow(/damaged or incomplete/);
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

test("an encrypted package and a duplicate or path-like part name are refused", async () => {
  await refused(extractDocument("locked.docx", zip([{ name: "word/document.xml", data: "<a/>", flags: 1 }])), "encrypted");
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
