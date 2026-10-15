import { test, expect } from "@playwright/test";
import { PDF_CSP, PDF_LIMITS, checkDeckHtml, isPdfSpec, mediaMatches, mediaMm, pdfFacts, validatePdfSpec } from "../../remotion/src/lib/pdf";
import { DeckTooLong, ppmDoc, pitchDoc, treatmentDoc } from "../../lib/pdf/builders";
import { MAX_PAGES, PAGE_SIZES, paginateRows, paginateText, textBudget } from "../../lib/pdf/deck";
import { deckHtml, esc } from "../../lib/pdf/html";
import { fakePdf } from "./remotionWorkerFake";

/* The deck pages of the PDF tool (lib/pdf/*): what a treatment, a pitch deck and a PPM deck are made of, how their words are cut into pages
   that fit, and the page checks the worker applies (remotion/src/lib/pdf.ts). Pure: no browser, no worker, no database. */

const DATE = "15 Oct 2026";
const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)> "quoted" 'single' & <b>bold</b> </style><style>@import url(http://evil.test/x.css)`;

const scenes = (n: number, long = false) => Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `Scene ${i + 1} ${HOSTILE}`, secs: 5 + i, prose: (long ? "A long sentence that keeps going and going. " : "Rain on the glass. ").repeat(long ? 120 : 6) + `\n\nSecond paragraph. ${HOSTILE}` }));
const shots = (n: number) => ({
  scenes: [{
    id: "s1", heading: "INT. ROOM", summary: "x", beats: [], characters: ["Ana", "Ben"], locations: ["Room"], props: ["Lamp"],
    shots: Array.from({ length: n }, (_, i) => ({ id: `sh${i}`, description: `Shot ${i} ${HOSTILE}`, framing: "Wide", movement: "Dolly in", lighting: "Soft key light from camera left, long and descriptive so a cell wraps over several lines in the table", sound: "Room tone", duration: 4 })),
  }],
});
const project = (n: number) => ({
  name: `My board ${HOSTILE}`, script: "INT. ROOM - DAY\n\nAna enters.\n\nShe waits. ".repeat(30), scriptVersions: [], nodes: [], boardShotList: {},
  production: { beats: { scriptSha256: "x", updatedAt: "", scenes: shots(n).scenes } },
}) as never;

test("a page of words is cut at a break and holds what the page can hold, and every word is kept", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} runs on for a little while, with words in it.`).join(" ");
  const pages = paginateText([text, "A second paragraph.", "A third."], textBudget("slide"));
  expect(pages.length).toBeGreaterThan(2);
  for (const page of pages) expect(page.join(" ").length).toBeLessThanOrEqual(textBudget("slide") + 200);
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  expect(pages.flat().flatMap(words)).toEqual(words(`${text} A second paragraph. A third.`));
  // A word without a break in it is still never lost.
  expect(paginateText(["x".repeat(3000)], 850).flat().join("").length).toBe(3000);
});

test("table rows are cut into pages by their height, so a tall row starts a new page and none is dropped", () => {
  const columns = [{ pct: 10 }, { pct: 40 }, { pct: 50 }];
  const rows = Array.from({ length: 60 }, (_, i) => [String(i), `short ${i}`, i % 5 === 0 ? "a very long cell ".repeat(25) : "tiny"]);
  const pages = paginateRows(columns, rows, "a4");
  expect(pages.flat().length).toBe(60);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.flat().map((r) => r[0])).toEqual(rows.map((r) => r[0]));
});

test("every word is escaped: hostile content becomes text and the page passes the worker's own check", () => {
  expect(esc(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  const docs = [
    treatmentDoc({ title: HOSTILE, logline: HOSTILE, setup: { [`k ${HOSTILE}`]: HOSTILE }, scenes: scenes(3), draft: 2 }, { date: DATE, pictures: [{ file: "i1.jpg", caption: HOSTILE }], logo: "i2.png" }),
    pitchDoc({ title: HOSTILE, logline: HOSTILE, audience: HOSTILE, sections: [{ heading: HOSTILE, paragraphs: [HOSTILE], bullets: [HOSTILE, "b"] }] }, { date: DATE }),
    ppmDoc(project(9), { date: DATE, pictures: [{ file: "i1.jpg", caption: "c" }] }),
  ];
  for (const doc of docs) {
    const html = deckHtml(doc);
    const problems = checkDeckHtml(html, doc.images);
    expect(problems, doc.kind).toEqual([]);
    expect(html).not.toMatch(/<(script|iframe|link|form|base|a|object|embed|svg)[\s>/]/i);
    expect(html).not.toMatch(/<[a-z][^>]* on[a-z]+=/i);
    expect(html).not.toMatch(/(src|href)="(https?:|\/\/|data:)/i);
    expect(html).toContain(PDF_CSP);
    expect(html).toContain("&lt;script&gt;");
    expect(html.match(/<section class="page/g)?.length).toBe(doc.pages.length);
  }
});

test("the worker's page check refuses everything that loads, runs or links", () => {
  const good = deckHtml(pitchDoc({ title: "T", sections: [{ heading: "H", paragraphs: ["p"] }] }, { date: DATE }));
  expect(checkDeckHtml(good, [])).toEqual([]);
  const bad: [string, string][] = [
    ["script", good.replace("<main>", "<main><script>1</script>")],
    ["inline handler", good.replace("<main>", '<main><p onclick="x()">a</p>')],
    ["external image", good.replace("<main>", '<main><img src="https://evil.test/a.png">')],
    ["image outside the session", good.replace("<main>", '<main><img src="assets/../../etc/passwd">')],
    ["undeclared image", good.replace("<main>", '<main><img src="assets/i9.png">')],
    ["link tag", good.replace("<head>", '<head><link rel="stylesheet" href="x.css">')],
    ["iframe", good.replace("<main>", '<main><iframe src="x"></iframe>')],
    ["object", good.replace("<main>", "<main><object data=x></object>")],
    ["svg", good.replace("<main>", "<main><svg></svg>")],
    ["form", good.replace("<main>", "<main><form action=x></form>")],
    ["anchor", good.replace("<main>", '<main><a href="http://x">y</a>')],
    ["base", good.replace("<head>", '<head><base href="http://evil.test/">')],
    ["meta refresh", good.replace("<head>", '<head><meta http-equiv="refresh" content="0;url=http://evil.test">')],
    ["a second policy", good.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src *">`)],
    ["no policy", good.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")],
    ["a weaker policy", good.replace(PDF_CSP, "default-src *")],
    ["comment", good.replace("<main>", "<main><!-- x -->")],
    ["style attribute", good.replace("<main>", '<main><p style="background:url(http://x)">a</p>')],
    ["css import", good.replace("</style>", "@import url(x.css);</style>")],
    ["another at-rule", good.replace("</style>", "@namespace x url(y);</style>")],
    ["css url to a host", good.replace("</style>", "body{background:url(http://evil.test/a.png)}</style>")],
    ["css url outside", good.replace("</style>", "body{background:url(../x.png)}</style>")],
    ["css escape", good.replace("</style>", "body{background:\\75rl(x)}</style>")],
    ["unknown tag", good.replace("<main>", "<main><marquee>x</marquee>")],
    ["unclosed markup", good.replace("<main>", "<main><p")],
    ["not text", ""],
  ];
  for (const [name, html] of bad) expect(checkDeckHtml(html, []).length, name).toBeGreaterThan(0);
  expect(checkDeckHtml(null, [])).toEqual(["deck.html is not text."]);
  expect(checkDeckHtml("x".repeat(PDF_LIMITS.htmlBytes + 1), []).length).toBe(1);
});

test("the spec: only a whole, bounded deck is accepted", () => {
  const ok = { version: 1, composition: "pdf", pdf: { pages: 3, trimMm: { width: 297, height: 210 }, bleedMm: 3, images: ["i1.jpg", "i2.png"] } };
  expect(validatePdfSpec(ok).ok).toBe(true);
  expect(isPdfSpec(ok)).toBe(true);
  expect(isPdfSpec({ composition: "captions" })).toBe(false);
  const refused: unknown[] = [
    null, [], { ...ok, extra: 1 }, { ...ok, version: 2 }, { ...ok, composition: "final" },
    { ...ok, pdf: { ...ok.pdf, pages: 0 } }, { ...ok, pdf: { ...ok.pdf, pages: PDF_LIMITS.pages + 1 } }, { ...ok, pdf: { ...ok.pdf, pages: 1.5 } },
    { ...ok, pdf: { ...ok.pdf, trimMm: { width: 10, height: 210 } } }, { ...ok, pdf: { ...ok.pdf, trimMm: { width: 297, height: 5000 } } },
    { ...ok, pdf: { ...ok.pdf, bleedMm: -1 } }, { ...ok, pdf: { ...ok.pdf, bleedMm: 11 } },
    { ...ok, pdf: { ...ok.pdf, images: ["../x.jpg"] } }, { ...ok, pdf: { ...ok.pdf, images: ["http://x/i1.jpg"] } }, { ...ok, pdf: { ...ok.pdf, images: ["i1.jpg", "i1.jpg"] } },
    { ...ok, pdf: { ...ok.pdf, images: Array.from({ length: 41 }, (_, i) => `i${i + 1}.png`) } }, { ...ok, pdf: { ...ok.pdf, url: "http://x" } },
  ];
  for (const spec of refused) expect(validatePdfSpec(spec).ok, JSON.stringify(spec)?.slice(0, 80)).toBe(false);
});

test("a PDF is read for what it is: its header, its page count and its page size", () => {
  const a4 = fakePdf(4, 297, 210);
  const facts = pdfFacts(a4);
  expect(facts.header).toBe(true);
  expect(facts.pages).toBe(4);
  const spec = { pages: 4, trimMm: { width: 297, height: 210 }, bleedMm: 0, images: [] };
  expect(mediaMatches(facts.mediaPt, spec)).toBe(true);
  expect(mediaMatches(facts.mediaPt, { ...spec, trimMm: { width: 279.4, height: 215.9 } })).toBe(false);
  // A bleed makes the page bigger by twice its width on each axis.
  expect(mediaMm({ ...spec, bleedMm: 3 })).toEqual({ width: 303, height: 216 });
  expect(mediaMatches(pdfFacts(fakePdf(4, 303, 216)).mediaPt, { ...spec, bleedMm: 3 })).toBe(true);
  expect(pdfFacts(Buffer.from("<html></html>")).header).toBe(false);
  expect(mediaMatches(null, spec)).toBe(false);
});

test("a treatment: a cover, its setup, a page or more for each scene, then the pictures", () => {
  const doc = treatmentDoc({ title: "Night Shift", logline: "A courier delivers one last parcel.", setup: { format: "Short film", tone_of_voice: "Dry" }, scenes: scenes(3, true), draft: 3 }, { date: DATE, pictures: Array.from({ length: 7 }, (_, i) => ({ file: `i${i + 1}.png`, caption: `Frame ${i + 1}` })) });
  expect(doc.kind).toBe("treatment");
  expect(doc.size).toBe("slide");
  expect(doc.pages[0]).toMatchObject({ type: "cover", title: "Night Shift", meta: ["Draft 3", DATE] });
  expect(doc.pages[1]).toMatchObject({ type: "facts", rows: [["Format", "Short film"], ["Tone of voice", "Dry"]] });
  const scenePages = doc.pages.filter((p) => p.type === "text");
  expect(scenePages.length).toBeGreaterThan(3);
  expect(doc.pages.filter((p) => p.type === "images").length).toBe(2);
  expect(doc.images).toEqual(Array.from({ length: 7 }, (_, i) => `i${i + 1}.png`));
});

test("a pitch deck: the cover and each section the caller wrote; nothing is added", () => {
  const doc = pitchDoc({ title: "Brand film", logline: "One idea.", audience: "For Acme", sections: [{ heading: "The idea", paragraphs: ["Short."] }, { heading: "Why now", bullets: ["a", "b"] }] }, { date: DATE, size: "a4", bleedMm: 3 });
  expect(doc.pages.map((p) => p.type)).toEqual(["cover", "text", "bullets"]);
  expect(doc.size).toBe("a4");
  expect(doc.bleedMm).toBe(3);
  expect(doc.pages[0]).toMatchObject({ meta: ["For Acme", DATE] });
});

test("a PPM deck: cover, contents, the script, the board's lists and the shot list as a table; an empty section has no page", () => {
  const doc = ppmDoc(project(30), { date: DATE });
  expect(doc.size).toBe("a4");
  expect(doc.pages[1]).toMatchObject({ type: "bullets", heading: "What this deck holds" });
  const table = doc.pages.filter((p) => p.type === "table");
  expect(table.length).toBeGreaterThan(1);
  expect(table.flatMap((p) => (p.type === "table" ? p.rows : [])).length).toBe(30);
  /* The board has no cast cards, so no Cast page; its beat sheet names a place and a prop. */
  expect(doc.pages.some((p) => p.type === "bullets" && p.heading === "Cast")).toBe(false);
  expect(doc.pages.some((p) => p.type === "bullets" && p.heading === "Locations")).toBe(true);
  expect(doc.pages.some((p) => p.type === "bullets" && p.heading === "Wardrobe and props")).toBe(true);
  const empty = ppmDoc({ name: "Bare", script: "", scriptVersions: [], nodes: [], boardShotList: {}, production: undefined } as never, { date: DATE });
  expect(empty.pages.map((p) => p.type)).toEqual(["cover", "bullets"]);
});

test("a deck of more than 60 pages is refused, not cut", () => {
  expect(() => treatmentDoc({ title: "Long", logline: "", setup: {}, scenes: scenes(MAX_PAGES + 5), draft: 1 }, { date: DATE })).toThrow(DeckTooLong);
  expect(PAGE_SIZES.slide.width / PAGE_SIZES.slide.height).toBeCloseTo(16 / 9, 2);
});
