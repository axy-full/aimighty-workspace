import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NOT_BUILT, menuFor, type MenuAction, type MenuEntry } from "../../lib/v12/menus";
import { keyOf } from "../../lib/v12/keymap";
import { recreateQuote } from "../../lib/v12/recreateQuote";

/**
 * The new interface's right-click menus as data (lib/v12/menus.ts; inventory § 5.11): the prototype's order and words,
 * only the items whose action exists for the target, keys from the keyboard map, and no price written in them.
 */
const all = (...ids: MenuAction[]) => new Set<MenuAction>(ids);
const labels = (entries: readonly MenuEntry[]) => entries.map((e) => (e.sep ? "—" : e.key ? `${e.label} ${e.key}` : e.label));

test("card: the prototype's order and words, with the keys that work", () => {
  const menu = menuFor("card", all("open", "download", "copy", "use-as-reference", "move", "redraw", "approve", "delete"));
  expect(labels(menu)).toEqual([
    "Open", "Download original", "—", "Copy ⌘C", "—", "Use as reference", "Move to board…", "—", "Redraw", "—", "Approve A", "—", "Delete ⌫",
  ]);
  const redraw = menu.find((e) => !e.sep && e.id === "redraw");
  expect(redraw && !redraw.sep && redraw.priced).toBe(true);
  const del = menu.find((e) => !e.sep && e.id === "delete");
  expect(del && !del.sep && del.danger).toBe(true);
});

test("a menu lists only what can be done, with no stray separators", () => {
  /* Home's wall: Open, Make one like this, Download original, Use as reference, Remix this (priced). */
  expect(labels(menuFor("card", all("open", "make-like", "download", "use-as-reference", "remix")))).toEqual([
    "Open", "Make one like this", "Download original", "—", "Use as reference", "—", "Remix this",
  ]);
  /* Only Delete: no separator before it. */
  expect(labels(menuFor("card", all("delete")))).toEqual(["Delete ⌫"]);
  expect(menuFor("card", all())).toEqual([]);
  for (const kind of ["card", "multi", "canvas", "empty", "board", "make-empty"] as const) {
    const menu = menuFor(kind, all("open", "download", "copy", "approve", "approve-all", "delete-all", "paste", "upload", "fit", "library", "palette", "copy-link"));
    if (!menu.length) continue;
    expect(menu[0].sep).toBeFalsy();
    expect(menu[menu.length - 1].sep).toBeFalsy();
    menu.forEach((e, i) => { if (e.sep) expect(menu[i - 1].sep).toBeFalsy(); });
  }
});

test("multi, canvas, empty space and a board card", () => {
  expect(labels(menuFor("multi", all("approve-all", "delete-all")))).toEqual(["Approve all A", "—", "Delete ⌫"]);
  const canvas = menuFor("canvas", all("paste", "new", "new-note", "new-text", "new-image", "new-video", "new-audio", "upload", "ask-atomik", "select-all", "tidy", "fit"));
  expect(labels(canvas)).toEqual(["Paste ⌘V", "—", "New", "Upload… U", "—", "Ask Atomik ⌘J", "—", "Select all ⌘A", "Tidy", "Zoom to fit 0"]);
  const fresh = canvas.find((e) => !e.sep && e.id === "new");
  expect(fresh && !fresh.sep && labels(fresh.sub ?? [])).toEqual(["Note N", "Text T", "Image I", "Video ⇧V", "Audio ⇧A"]);
  /* A submenu with nothing in it is left out, not drawn empty. */
  expect(labels(menuFor("canvas", all("new", "fit")))).toEqual(["Zoom to fit 0"]);
  expect(labels(menuFor("empty", all("library", "make", "ask-atomik", "palette")))).toEqual(["Library L", "Make ⌘2", "—", "Atomik panel ⌘J", "Ask Atomik, search or go to ⌘K"]);
  expect(labels(menuFor("board", all("open", "copy-link")))).toEqual(["Open", "Copy link"]);
  expect(labels(menuFor("make-empty", all("select-results", "library", "palette")))).toEqual(["Select all", "—", "Library L", "Ask Atomik, search or go to ⌘K"]);
});

test("a Make result: the card menu less Approve and Lock, with Load prompt", () => {
  expect(labels(menuFor("card", all("open", "load-prompt", "download", "use-as-reference")))).toEqual(["Open", "Load prompt", "Download original", "—", "Use as reference"]);
});

test("the keys menus show are the keyboard map's", () => {
  const menu = menuFor("card", all("copy", "approve", "delete"));
  expect(menu.filter((e) => !e.sep).map((e) => (e.sep ? "" : e.key))).toEqual([keyOf("copy"), keyOf("approve"), keyOf("delete")]);
});

test("no price is written in a menu: priced items take theirs from the quote layer", () => {
  const code = readFileSync(path.resolve(__dirname, "../../lib/v12/menus.ts"), "utf8");
  expect(code).not.toMatch(/\d\s*cr\b/);
  const entries = (["card", "multi", "canvas", "empty", "board", "make-empty"] as const).flatMap((kind) => menuFor(kind, all(
    "open", "make-like", "load-prompt", "download", "copy", "use-as-reference", "move", "redraw", "remix", "approve", "delete", "copy-link", "approve-all", "delete-all",
    "paste", "new", "new-note", "new-text", "new-image", "new-video", "new-audio", "upload", "ask-atomik", "select-all", "tidy", "fit", "library", "make", "palette",
    "select-results", "clear-selection",
  )));
  for (const e of entries) if (!e.sep) expect(e.label).not.toMatch(/\d/);
  expect(entries.filter((e) => !e.sep && e.priced).map((e) => (e.sep ? "" : e.id)).sort()).toEqual(["redraw", "remix"]);
});

test("what the prototype lists and the app cannot do yet is written down, with why", () => {
  expect(NOT_BUILT.length).toBeGreaterThan(5);
  for (const row of NOT_BUILT) expect(row.why.length).toBeGreaterThan(10);
});

test("Redraw's price: today's Recreate figure, worded by the quote layer", () => {
  expect(recreateQuote(null)).toEqual({ state: "idle" });
  expect(recreateQuote({ state: "reading" })).toEqual({ state: "loading" });
  expect(recreateQuote({ state: "unavailable", reason: "No engine is offered for this take right now." })).toEqual({ state: "error", message: "No engine is offered for this take right now." });
  expect(recreateQuote({ state: "ready", credits: 43, approximate: false })).toEqual({ state: "ready", price: { unit: "cr", value: { kind: "exact", credits: 43 } } });
  expect(recreateQuote({ state: "ready", credits: 1, approximate: false, estimate: true })).toEqual({ state: "ready", price: { unit: "cr", value: { kind: "up-to", credits: 1 } } });
  /* Cinema Studio holds three times its estimate and may settle there: "up to" the hold. */
  expect(recreateQuote({ state: "ready", credits: 31, approximate: true, held: true })).toEqual({ state: "ready", price: { unit: "cr", value: { kind: "up-to", credits: 93 } } });
  /* The house workspace pays in dollars, which this route does not give: no credit figure. */
  expect(recreateQuote({ state: "ready", credits: 43, approximate: false }, true).state).toBe("error");
});
