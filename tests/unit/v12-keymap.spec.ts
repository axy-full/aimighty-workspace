import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { KEYMAP, chordOf, clashes, keyOf, strokes, typingIn, type KeyBinding } from "../../lib/v12/keymap";
import { menuKeys } from "../../lib/v12/menus";
import { headerKey } from "../../components/v12/shell/tabs";

/**
 * The new interface's keyboard map (lib/v12/keymap.ts; inventory § 4.2; plan decision 3). Fails when two keys clash,
 * and when the new interface shows a key the map does not have (a key shown is a key that works).
 */

test("no two keys clash where they are on screen together", () => {
  expect(clashes().map((c) => c.why)).toEqual([]);
});

test("a clash is caught: the same key for two actions, or a key that starts another's sequence", () => {
  const extra = (b: Partial<KeyBinding> & Pick<KeyBinding, "id" | "keys" | "place">): KeyBinding => ({ does: b.id, ...b });
  /* The prototype's own clash (inventory § 4.2): A toggled Atomik on a board while its menus said Approve · A. */
  const prototype = clashes([...KEYMAP, extra({ id: "atomik-a", keys: "A", place: "board" })]);
  expect(prototype.map((c) => [c.a.id, c.b.id].sort())).toContainEqual(["approve", "atomik-a"].sort());
  /* "Group into frame G" would swallow "G H". */
  const group = clashes([...KEYMAP, extra({ id: "group", keys: "G", place: "card" })]);
  expect(group.some((c) => [c.a.id, c.b.id].includes("home-seq"))).toBe(true);
  /* Two places never on screen together may share a key: Esc in the viewer and Esc in a menu. */
  expect(clashes([extra({ id: "x", keys: "Esc", place: "viewer" }), extra({ id: "y", keys: "Esc", place: "menu" })])).toEqual([]);
  /* One action on two surfaces is not a clash: ⌫ on a board card and on a Library file. */
  expect(clashes([extra({ id: "delete", keys: "⌫", place: "card" }), extra({ id: "delete-file", keys: "⌫", place: "file", action: "delete" })])).toEqual([]);
});

test("plan decision 3: A approves the selected card and ⌘J toggles the Atomik panel", () => {
  expect(keyOf("approve")).toBe("A");
  expect(KEYMAP.find((b) => b.id === "approve")?.place).toBe("card");
  expect(keyOf("atomik-panel")).toBe("⌘J");
  expect(KEYMAP.filter((b) => b.keys === "A")).toHaveLength(1);
});

test("the header's keys are the map's (components/v12/shell/tabs.ts headerKey)", () => {
  const ev = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
  expect(headerKey(ev("j", { metaKey: true }))).toEqual({ toggle: "atomik" });
  expect(chordOf(ev("j", { metaKey: true }))).toBe(keyOf("atomik-panel"));
  expect(headerKey(ev("1", { ctrlKey: true }))).toEqual({ go: "home" });
  expect(chordOf(ev("1", { ctrlKey: true }))).toBe(keyOf("home"));
  expect(headerKey(ev("2", { metaKey: true }))).toEqual({ go: "make" });
  expect(chordOf(ev("2", { metaKey: true }))).toBe(keyOf("make"));
  for (let n = 3; n <= 9; n++) {
    expect(headerKey(ev(String(n), { metaKey: true }))).toEqual({ go: "board", index: n - 3 });
    expect(chordOf(ev(String(n), { metaKey: true }))).toBe(keyOf(`tab-${n}`));
  }
  expect(headerKey(ev("g"))).toEqual({ pending: "g" });
  expect(headerKey(ev("h"), true)).toEqual({ go: "home" });
  expect(strokes(keyOf("home-seq")).map((k) => chordOf(ev(k.toLowerCase())))).toEqual(["G", "H"]);
});

test("a keypress reads as the map writes it", () => {
  expect(chordOf({ key: "V", shiftKey: true })).toBe("⇧V");
  expect(chordOf({ key: "A", shiftKey: true })).toBe("⇧A");
  expect(chordOf({ key: "a" })).toBe("A");
  expect(chordOf({ key: "a", metaKey: true })).toBe("⌘A");
  expect(chordOf({ key: "µ", altKey: true, code: "KeyM" })).toBe("⌥M");
  expect(chordOf({ key: "Backspace" })).toBe("⌫");
  expect(chordOf({ key: "Delete" })).toBe("⌫");
  expect(chordOf({ key: "Escape" })).toBe("Esc");
  expect(chordOf({ key: "0" })).toBe("0");
  expect(chordOf({ key: "Shift", shiftKey: true })).toBeNull();
  /* "@" is typed with ⇧ on most layouts: it stays "@". */
  expect(chordOf({ key: "@", shiftKey: true })).toBe("@");
});

test("keys never fire while typing: inputs, text areas, selects and editable text", () => {
  const at = (match: string | null, editable = false) => ({ isContentEditable: editable, closest: (sel: string) => (match && sel.includes(match) ? {} : null) });
  expect(typingIn(at("input"))).toBe(true);
  expect(typingIn(at("textarea"))).toBe(true);
  expect(typingIn(at("select"))).toBe(true);
  expect(typingIn(at(null, true))).toBe(true);
  expect(typingIn(at(null))).toBe(false);
  expect(typingIn(null)).toBe(false);
});

/* Every key the new interface shows: in its menus, its tooltips and its key-caps. */
const V12 = path.resolve(__dirname, "../../components/v12");
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/.test(name) ? [full] : [];
});
/* The primitives' own gallery (a dev page) shows sample keys on purpose. */
const shipped = sources(V12).filter((file) => !file.includes(`${path.sep}dev${path.sep}`));
const known = new Set(KEYMAP.map((b) => b.keys));

test("every key a menu shows is in the map", () => {
  for (const key of menuKeys()) expect(known.has(key), key).toBe(true);
});

test("every key the new interface shows is in the map, and every keyOf names one", () => {
  const ids = new Set(KEYMAP.map((b) => b.id));
  const shown: string[] = [];
  const named: string[] = [];
  for (const file of shipped) {
    const code = readFileSync(file, "utf8");
    /* Written keys: shortcut="…", shortcut: "…", <Kbd keys="…">, and arrays of them. */
    for (const m of code.matchAll(/\b(?:shortcut|keys)\s*[=:]\s*\{?\s*(\[[^\]]*\]|"[^"]*")/g)) {
      for (const lit of m[1].replace(/keyOf\("[^"]*"\)/g, "").matchAll(/"([^"]+)"/g)) shown.push(`${path.basename(file)}: ${lit[1]}`);
    }
    for (const m of code.matchAll(/keyOf\("([^"]+)"\)/g)) named.push(m[1]);
  }
  expect(shown.filter((s) => !known.has(s.split(": ")[1]))).toEqual([]);
  expect(named.filter((id) => !ids.has(id))).toEqual([]);
  /* The menus and tooltips read the map: there is at least one reader in each. */
  expect(named.length).toBeGreaterThan(5);
});
