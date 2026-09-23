import { test, expect } from "@playwright/test";
import {
  ALL_SHELL_PAGES, HEADER_SEGMENT, SHELL_SUITES, WORKSPACE_TABS, firstShellPage, isShellSuite, pageOfLegacy, restorePage, shellPage, suiteOfLegacy,
} from "../../lib/shell/ia";
import { PAGES } from "../../lib/workspace/pages";
import { UNDO_DEPTH, popUndo, pushUndo, type UndoEntry } from "../../lib/shell/undo";
import { ctxItems, parseCtx, placeMenu, shortcutCommand, type CtxCapabilities, type CtxItem } from "../../lib/shell/context-menu";
import { PALETTE_ROWS, paletteIndex, searchPalette } from "../../lib/shell/palette";

/* ── Information architecture ───────────────────────────────────────────── */

test("the header segment reads Studio | Gen | Business | Viral | Atomik | Crew", () => {
  expect(HEADER_SEGMENT.map((s) => s.label)).toEqual(["Studio", "Gen", "Business", "Viral", "Atomik", "Crew"]);
});

test("every suite has the README's pages, numbered in order, with its group gaps; the phone's Studio home sits outside the strip", () => {
  const shape = Object.fromEntries(SHELL_SUITES.map((s) => [s.id, s.pages.filter((p) => !p.phoneOnly).map((p) => `${p.gapBefore ? "|" : ""}${p.n} ${p.label}`)]));
  const home = SHELL_SUITES.find((s) => s.id === "studio")!.pages.find((p) => p.phoneOnly);
  expect(home).toMatchObject({ id: "home", n: "", own: true });
  expect(shape).toEqual({
    studio: ["01 Brief", "02 Beats", "03 Storyboards", "|04 Cast", "05 Astra", "06 Rig", "|07 Takes", "08 Edit & Sound", "09 Deliver"],
    business: ["01 Ads", "02 Image ads", "|03 Setup"],
    viral: ["01 Motion Transfer", "02 Object Swap", "|03 History"],
    atomik: ["01 Agent", "|02 Runs", "03 Approvals", "04 Budget", "|05 Models", "06 Skills"],
  });
});

test("every shell page is backed by a page the state layer really has", () => {
  for (const { suite, page } of ALL_SHELL_PAGES) {
    const known = PAGES[page.legacy.suite].map((p) => p.id);
    expect(known, `${suite.id}/${page.id}`).toContain(page.legacy.page);
    expect(page.legacy.suite).toBe(suite.legacy);
  }
});

test("a suite restores its remembered page and falls back to its first", () => {
  expect(restorePage("studio", "rig").id).toBe("rig");
  expect(restorePage("studio", "gone").id).toBe(firstShellPage("studio").id);
  expect(restorePage("viral", null).id).toBe("motion");
  expect(shellPage("atomik", "budget")?.title).toBe("Budget");
  expect(isShellSuite("studio")).toBe(true);
  expect(isShellSuite("gen")).toBe(false);
});

test("a state-layer page finds its shell page; a shared backing page follows the hint", () => {
  expect(suiteOfLegacy("moleculr")).toBe("business");
  /* Beats shares Brief's backing page and follows the hint. */
  expect(pageOfLegacy("particl", "takes")?.id).toBe("takes");
  expect(pageOfLegacy("particl", "edit")?.id).toBe("edit");
  expect(pageOfLegacy("particl", "brief", "beats")?.id).toBe("beats");
  expect(pageOfLegacy("moleculr", "marketing")?.id).toBe("ads");
  expect(pageOfLegacy("moleculr", "marketing", "setup")?.id).toBe("setup");
  expect(pageOfLegacy("moleculr", "marketing", "not-a-page")?.id).toBe("ads");
});

test("suite names and marks are the design's, verbatim", () => {
  /* Owner decision, 21 September 2026: the Suites surface follows the design
     README's names; the never-name rule covers the legacy screens only. */
  expect(SHELL_SUITES.map((s) => [s.mark, s.name])).toEqual([
    ["STUDIO", "Particl Production Studio"],
    ["BUSINESS", "Moleculr Business Suite · Marketing Studio"],
    ["VIRAL", "Subatomik Viral Studio · Genjutsu"],
    ["SUPERCOMPUTER", "Atomik Supercomputer"],
  ]);
  for (const s of SHELL_SUITES) expect(HEADER_SEGMENT.find((h) => h.id === s.id)?.title).toBe(s.name);
});

/* ── Undo ───────────────────────────────────────────────────────────────── */

test("the undo stack keeps the newest twenty and pops newest first", () => {
  let stack: UndoEntry[] = [];
  for (let i = 0; i < UNDO_DEPTH + 5; i++) stack = pushUndo(stack, { label: `step ${i}`, undo: () => {} });
  expect(stack).toHaveLength(UNDO_DEPTH);
  expect(stack[0].label).toBe("step 5");
  const popped = popUndo(stack)!;
  expect(popped.entry.label).toBe(`step ${UNDO_DEPTH + 4}`);
  expect(popped.rest).toHaveLength(UNDO_DEPTH - 1);
  expect(popUndo([])).toBeNull();
});

/* ── Right-click menu ───────────────────────────────────────────────────── */

const caps = (over: Partial<CtxCapabilities> = {}): CtxCapabilities => ({ can: {}, why: {}, hasClipboard: false, canUndo: false, ...over });
const commands = (items: CtxItem[]) => items.map((i) => (i.sep ? "—" : i.command));
const find = (items: CtxItem[], command: string) => items.find((i) => !i.sep && i.command === command) as Exclude<CtxItem, { sep: true }>;

test("data-ctx parses to an asset, a node, or empty space", () => {
  expect(parseCtx("asset:tk_1")).toEqual({ kind: "asset", id: "tk_1" });
  expect(parseCtx("node:n:1")).toEqual({ kind: "node", id: "n:1" });
  for (const bad of [null, "", "asset:", "page:x", "asset"]) expect(parseCtx(bad)).toEqual({ kind: "empty" });
});

test("the menu follows the README's order for each target", () => {
  const head = ["copy", "cut", "paste", "duplicate", "—"];
  const tail = ["move", "retry", "—", "delete", "undo"];
  expect(commands(ctxItems({ kind: "asset", id: "a" }, caps()))).toEqual([...head, "use-as-reference", "open-in-inspector", ...tail]);
  expect(commands(ctxItems({ kind: "node", id: "n" }, caps()))).toEqual([...head, "bypass", "unplug", ...tail]);
  expect(commands(ctxItems({ kind: "empty" }, caps()))).toEqual([...head, ...tail, "—", "generate-here", "open-library", "toggle-inspector"]);
});

test("a blocked item stays in the menu, disabled, with its reason", () => {
  const items = ctxItems({ kind: "asset", id: "a" }, caps({ can: { copy: true }, why: { delete: "Arrives next step." } }));
  expect(find(items, "copy").disabled).toBeFalsy();
  expect(find(items, "delete")).toMatchObject({ disabled: true, reason: "Arrives next step." });
  expect(find(items, "move")).toMatchObject({ disabled: true, reason: "Not available for this selection." });
  expect(find(items, "paste")).toMatchObject({ disabled: true, reason: "Nothing copied yet." });
  expect(find(items, "undo")).toMatchObject({ disabled: true, reason: "Nothing to undo." });
  const ready = ctxItems({ kind: "asset", id: "a" }, caps({ can: { paste: true }, hasClipboard: true, canUndo: true }));
  expect(find(ready, "paste").disabled).toBeFalsy();
  expect(find(ready, "undo").disabled).toBeFalsy();
});

test("empty space blocks selection commands but keeps its own three", () => {
  const items = ctxItems({ kind: "empty" }, caps({ can: { copy: true } }));
  expect(find(items, "copy")).toMatchObject({ disabled: true, reason: "Select an asset or a node first." });
  for (const c of ["generate-here", "open-library", "toggle-inspector"]) expect(find(items, c).disabled).toBeFalsy();
});

test("the menu opens at the cursor, flips at an edge and never leaves the viewport", () => {
  const menu = { width: 220, height: 300 };
  const view = { width: 1440, height: 900 };
  expect(placeMenu({ x: 100, y: 100 }, menu, view)).toEqual({ left: 100, top: 100 });
  expect(placeMenu({ x: 1400, y: 880 }, menu, view)).toEqual({ left: 1180, top: 580 });
  /* A phone narrower than flip room: clamped to the 8px margin on both sides. */
  const phone = placeMenu({ x: 200, y: 600 }, menu, { width: 360, height: 640 });
  expect(phone.left).toBeGreaterThanOrEqual(8);
  expect(phone.left + menu.width).toBeLessThanOrEqual(360 - 8);
  expect(phone.top + menu.height).toBeLessThanOrEqual(640 - 8);
});

test("shortcuts map to commands; modifiers that mean something else do not", () => {
  const key = (k: string, over = {}) => shortcutCommand({ key: k, metaKey: true, ctrlKey: false, ...over });
  expect(["c", "x", "v", "d", "z", "r"].map((k) => key(k))).toEqual(["copy", "cut", "paste", "duplicate", "undo", "retry"]);
  expect(shortcutCommand({ key: "Backspace", metaKey: false, ctrlKey: false })).toBe("delete");
  expect(shortcutCommand({ key: "c", metaKey: false, ctrlKey: true })).toBe("copy");
  expect(key("z", { shiftKey: true })).toBeNull();
  expect(key("c", { altKey: true })).toBeNull();
  expect(shortcutCommand({ key: "c", metaKey: false, ctrlKey: false })).toBeNull();
  expect(key("k")).toBeNull();
});

/* ── ⌘K ─────────────────────────────────────────────────────────────────── */

const rows = paletteIndex({
  models: [{ id: "m1", name: "Seedance 2.5", kind: "video" }],
  assets: [{ id: "tk_1", name: "Rigging diagram", kind: "image" }],
});

test("the palette indexes Generate, suites, every page, Workspace, models and assets", () => {
  expect(rows[0]).toMatchObject({ label: "Generate", run: { type: "gen" } });
  expect(rows.filter((r) => r.run.type === "suite")).toHaveLength(4);
  expect(rows.filter((r) => r.run.type === "page")).toHaveLength(ALL_SHELL_PAGES.length);
  expect(rows.filter((r) => r.run.type === "workspace")).toHaveLength(WORKSPACE_TABS.length);
  expect(rows.some((r) => r.run.type === "model")).toBe(true);
  expect(rows.some((r) => r.run.type === "asset")).toBe(true);
});

test("search ranks a page's own name first and always ends with Ask Atomik", () => {
  const hits = searchPalette(rows, "rig");
  expect(hits[0].run).toEqual({ type: "page", suite: "studio", page: "rig" });
  expect(hits.at(-1)).toMatchObject({ label: "Ask Atomik: rig", run: { type: "ask", text: "rig" } });
  /* The asset "Rigging diagram" matches too, below the page. */
  expect(hits.some((r) => r.run.type === "asset")).toBe(true);
  expect(searchPalette(rows, "zzzz")).toEqual([expect.objectContaining({ run: { type: "ask", text: "zzzz" } })]);
  expect(searchPalette(rows, "")).toHaveLength(PALETTE_ROWS);
  expect(searchPalette(rows, "a").length).toBeLessThanOrEqual(PALETTE_ROWS);
  expect(searchPalette(rows, "budget atomik")[0].run).toEqual({ type: "page", suite: "atomik", page: "budget" });
});
