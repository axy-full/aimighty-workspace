import { test, expect } from "@playwright/test";
import { READING } from "../../lib/copy";
import {
  breakdown, breakdownItem, briefBreakdown, CHECK_TURN, citationsOf, danglingCitations, mockBreakdownWriter, scriptBreakdown, writeBreakdown,
  WRITE_TURN, type Breakdown, type BreakdownInput, type BreakdownItem, type BreakdownStore,
} from "../../lib/reading/breakdown";
import type { ReadingBlock } from "../../lib/reading/shapes";

/*
 * The breakdown of a brief or script as a Reading item (owner's note of 26 Oct 2026, item 6b; SOW v2 §9 Brief and Script,
 * Part II.1 and II.2, cited only): the Zod shapes, every line citing its source, the writer and the check as two slots, the
 * mock engine only, the store a stub. Nothing here bills, reads a file or calls a model.
 */

const SECRET = "SENTINEL-brief-text-that-must-never-leak";
const block = (page: number, seq: number, kind: ReadingBlock["kind"], text: string): ReadingBlock =>
  ({ page, seq, part: 0, kind, x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2, text, confidence: null });
const BLOCKS: ReadingBlock[] = [
  block(1, 0, "heading", "INT. KITCHEN - NIGHT"),
  block(1, 1, "paragraph", `A steel bottle on the counter. ${SECRET}`),
  block(2, 2, "heading", "EXT. PLATFORM - DAWN"),
  block(2, 3, "paragraph", "The train is late; the drink is still cold."),
];
const BRIEF: BreakdownInput = { readingId: "drd_brief1", kind: "brief", blocks: BLOCKS };
const SCRIPT: BreakdownInput = { readingId: "drd_script1", kind: "script", blocks: BLOCKS };
const line = (text: string, page = 1, seq = 1, readingId = "drd_brief1") => ({ text, cites: [{ readingId, page, seq }] });

const keeping = (): BreakdownStore & { kept: BreakdownItem[] } => {
  const kept: BreakdownItem[] = [];
  return { keeps: true, kept, async put(item) { kept.push(item); } };
};

test("the shapes: a brief's story and a script's entries, every line cited, nothing extra", () => {
  const full: Breakdown = {
    kind: "brief",
    summary: line("A bottle that keeps a drink cold through a long day."),
    hook: line("The drink is still cold at dawn.", 2, 3),
    pennyDrop: line("The late train no longer matters.", 2, 3),
    tonality: { word: "Deadpan", reason: line("Told flat, as the commute is.", 2, 3) },
    pace: { montage: false, highSpeed: null, note: null },
    moments: [line("The first sip on the platform.", 2, 3)],
    have: [line("A packshot of the bottle.")],
    open: ["the voice"],
  };
  expect(briefBreakdown.parse(full)).toEqual(full);
  /* Nothing invented: a line with no citation is refused; so is a field the shape does not have. */
  expect(briefBreakdown.safeParse({ ...full, hook: { text: "x", cites: [] } }).success).toBe(false);
  expect(briefBreakdown.safeParse({ ...full, model: "x" }).success).toBe(false);
  expect(briefBreakdown.safeParse({ ...full, tonality: { word: "", reason: full.tonality!.reason } }).success).toBe(false);
  /* A script: one entry per scene or beat, numbered in order from 1. */
  const entry = (n: number) => ({ n, unit: "scene", happens: line("x"), who: [], lines: [], tone: null, lands: null, needs: { cast: [], props: [], place: [], words: [] } });
  expect(scriptBreakdown.safeParse({ kind: "script", entries: [entry(1), entry(2)] }).success).toBe(true);
  expect(scriptBreakdown.safeParse({ kind: "script", entries: [entry(1), entry(3)] }).success).toBe(false);
  expect(scriptBreakdown.safeParse({ kind: "script", entries: [] }).success).toBe(false);
  expect(citationsOf(full)).toHaveLength(6);
});

test("the two slots: the Treatment writer writes, the production's Thinking checks; the item names roles, never a model", () => {
  expect(WRITE_TURN).toBe("breakdown");
  expect(CHECK_TURN).toBe("plan");
  expect(breakdownItem.shape.writtenBy.value).toBe("treatment_writer");
  expect(breakdownItem.shape.checkedBy.value).toBe("thinking");
});

test("a brief's breakdown through the mock engine: written, checked, every line on a block of this reading, kept nowhere yet", async () => {
  const done = await writeBreakdown(BRIEF, { write: mockBreakdownWriter });
  expect(done.state).toBe("done");
  if (done.state !== "done") return;
  expect(done.stored).toBe(false);
  expect(done.item).toMatchObject({ readingId: "drd_brief1", writtenBy: "treatment_writer", checkedBy: "thinking", breakdown: { kind: "brief" } });
  expect(breakdown.parse(done.item.breakdown)).toEqual(done.item.breakdown);
  expect(citationsOf(done.item.breakdown).length).toBeGreaterThan(0);
  expect(danglingCitations(done.item.breakdown, "drd_brief1", BLOCKS)).toEqual([]);
  /* A store that keeps gets the item as answered. */
  const store = keeping();
  const kept = await writeBreakdown(BRIEF, { write: mockBreakdownWriter, store });
  expect(kept).toMatchObject({ state: "done", stored: true });
  expect(store.kept).toHaveLength(1);
});

test("a script's breakdown: one entry per scene, in order, each citing its heading", async () => {
  const done = await writeBreakdown(SCRIPT, { write: mockBreakdownWriter });
  expect(done.state).toBe("done");
  if (done.state !== "done" || done.item.breakdown.kind !== "script") throw new Error("not a script breakdown");
  expect(done.item.breakdown.entries.map((e) => [e.n, e.happens.text, e.happens.cites[0]])).toEqual([
    [1, "INT. KITCHEN - NIGHT", { readingId: "drd_script1", page: 1, seq: 0 }],
    [2, "EXT. PLATFORM - DAWN", { readingId: "drd_script1", page: 2, seq: 2 }],
  ]);
});

test("off the mock engine there is no writer: 'Nothing billed', nothing kept", async () => {
  const store = keeping();
  expect(await writeBreakdown(BRIEF, { write: null, store })).toEqual({ state: "failed", errorCode: "writer_unavailable", message: READING.unavailable });
  expect(await writeBreakdown(BRIEF, { check: null, store })).toMatchObject({ errorCode: "writer_unavailable" });
  expect(store.kept).toEqual([]);
});

test("every failure answers a code and fixed words, never the source's text, and keeps nothing", async () => {
  const store = keeping();
  const cases: [string, Parameters<typeof writeBreakdown>[1], string][] = [
    ["a line citing a block this reading lacks", { write: async () => ({ ...(await mockBreakdownWriter(BRIEF)), hook: line(SECRET, 9, 99) }) }, "uncited"],
    ["a line citing another reading", { write: async () => ({ ...(await mockBreakdownWriter(BRIEF)), hook: line(SECRET, 1, 1, "drd_other") }) }, "uncited"],
    ["a script answered for a brief", { write: () => mockBreakdownWriter(SCRIPT) }, "bad_breakdown"],
    ["prose instead of the shape", { write: async () => SECRET }, "bad_breakdown"],
    ["the check does not hold", { write: mockBreakdownWriter, check: async () => ({ holds: false }) }, "check_failed"],
    ["the writer throws", { write: async () => { throw new Error(SECRET); } }, "writer_unavailable"],
    ["the check throws", { write: mockBreakdownWriter, check: async () => { throw new Error(SECRET); } }, "writer_unavailable"],
  ];
  for (const [what, deps, code] of cases) {
    const out = await writeBreakdown(BRIEF, { ...deps, store });
    expect(out, what).toMatchObject({ state: "failed", errorCode: code });
    expect(JSON.stringify(out), what).not.toContain(SECRET);
  }
  expect(store.kept).toEqual([]);
});

test("bad input is refused before any slot runs", async () => {
  let ran = false;
  const write = async () => { ran = true; return null; };
  for (const bad of [{ ...BRIEF, readingId: "../x" }, { ...BRIEF, blocks: [] }, { ...BRIEF, kind: "deck" }, { ...BRIEF, extra: 1 }]) {
    await expect(writeBreakdown(bad as BreakdownInput, { write })).rejects.toThrow();
  }
  expect(ran).toBe(false);
});
