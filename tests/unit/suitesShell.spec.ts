import { test, expect } from "@playwright/test";
import {
  ALL_SHELL_PAGES, HEADER_SEGMENT, SHELL_SUITES, WORKSPACE_TABS, firstShellPage, isShellSuite, pageOfLegacy, restorePage, shellPage, suiteOfLegacy,
  pageAlias,
} from "../../lib/shell/ia";
import { PAGES } from "../../lib/workspace/pages";
import { UNDO_DEPTH, boundUndo, canUndo, popUndo, pushUndo, type UndoEntry } from "../../lib/shell/undo";
import { ctxItems, inSelectionSurface, parseCtx, placeMenu, shortcutApplies, shortcutCommand, type CtxCapabilities, type CtxItem } from "../../lib/shell/context-menu";
import { PALETTE_ROWS } from "../../lib/shell/palette";

/* ── Information architecture ───────────────────────────────────────────── */

test("the header segment is option B: Home · the project · Make · Atomik", () => {
  expect(HEADER_SEGMENT.map((s) => [s.id, s.label])).toEqual([["home", "Home"], ["project", "Project"], ["make", "Make"], ["atomik", "Atomik"]]);
});

test("every suite has the README's pages, numbered in order, with its group gaps; Studio has Home only (the stage pages are the board's regions)", () => {
  const shape = Object.fromEntries(SHELL_SUITES.map((s) => [s.id, s.pages.filter((p) => !p.phoneOnly && !p.stripHidden).map((p) => `${p.gapBefore ? "|" : ""}${p.n} ${p.label}`)]));
  const home = SHELL_SUITES.find((s) => s.id === "studio")!.pages.find((p) => p.id === "home");
  expect(home).toMatchObject({ id: "home", n: "", own: true, phoneOnly: true });
  /* The ten Studio stage pages are deleted: Studio keeps the overview and the phone's Home, both Home's, neither a stage. */
  expect(SHELL_SUITES.find((s) => s.id === "studio")!.pages.map((p) => p.id)).toEqual(["stages", "home"]);
  expect(shape).toEqual({
    studio: [],
    business: ["01 Image ads", "|02 Setup", "|03 Brand", "04 Product", "05 Format", "06 Hooks", "07 Reference", "08 Design"],
    /* Motion Transfer and Object Swap are Make's quick tools (lib/shell/make.ts); History stays a page. */
    viral: ["01 History"],
    /* The control room's own four tabs, in the design's order (Atomik frames g–j), unnumbered; Agent, Budget, Models and Tools are not tabs. */
    atomik: [" Approvals", " Activity", " Skills", " Memory"],
  });
});

test("Atomik's strip is the control room's four tabs and nothing else; the retired pages still resolve, so their addresses can redirect", () => {
  const atomik = SHELL_SUITES.find((s) => s.id === "atomik")!;
  expect(atomik.pages.filter((p) => !p.stripHidden).map((p) => p.id)).toEqual(["approvals", "runs", "saved-skills", "memory"]);
  expect(atomik.pages.filter((p) => !p.stripHidden).every((p) => p.n === "")).toBe(true);
  for (const id of ["agent", "budget", "models", "skills"]) expect(shellPage("atomik", id), id).toMatchObject({ stripHidden: true });
  expect(firstShellPage("atomik").id).toBe("approvals");
});

test("Atomik › Memory is the shell's own page on Agent's backing page, told apart by the hint", () => {
  expect(shellPage("atomik", "memory")).toMatchObject({ title: "Memory", own: true, legacy: { suite: "atomik", page: "agent" } });
  expect(pageOfLegacy("atomik", "agent")?.id).toBe("agent");
  expect(pageOfLegacy("atomik", "agent", "memory")?.id).toBe("memory");
});

test("Atomik › Skills is the shell's own page beside Memory, on Agent's backing page; `skills` still means Tools & connections", () => {
  expect(shellPage("atomik", "saved-skills")).toMatchObject({ n: "", label: "Skills", title: "Skills", own: true, legacy: { suite: "atomik", page: "agent" } });
  expect(shellPage("atomik", "skills")?.title).toBe("Tools & connections");
  expect(pageOfLegacy("atomik", "agent")?.id).toBe("agent");
  expect(pageOfLegacy("atomik", "agent", "saved-skills")?.id).toBe("saved-skills");
});

test("every shell page is backed by a page the state layer really has", () => {
  for (const { suite, page } of ALL_SHELL_PAGES) {
    const known = PAGES[page.legacy.suite].map((p) => p.id);
    expect(known, `${suite.id}/${page.id}`).toContain(page.legacy.page);
    expect(page.legacy.suite).toBe(suite.legacy);
  }
});

test("a suite restores its remembered page and falls back to its first", () => {
  /* A stage id is not a page any more (it is a region of the board): it restores Studio's first page, the overview. */
  expect(restorePage("studio", "rig").id).toBe("stages");
  expect(restorePage("studio", "gone").id).toBe(firstShellPage("studio").id);
  expect(restorePage("viral", null).id).toBe("history");
  expect(restorePage("viral", "motion").id).toBe("history");
  expect(shellPage("atomik", "budget")?.title).toBe("Budget");
  expect(isShellSuite("studio")).toBe(true);
  expect(isShellSuite("gen")).toBe(false);
});

test("a state-layer page finds its shell page; a shared backing page follows the hint", () => {
  expect(suiteOfLegacy("moleculr")).toBe("business");
  /* Beats shares Brief's backing page and follows the hint. */
  expect(pageOfLegacy("particl", "takes")).toBeNull();
  expect(pageOfLegacy("particl", "edit")).toBeNull();
  /* Studio's two pages share Brief's backing page; the hint tells them apart, and the overview is the default. */
  expect(pageOfLegacy("particl", "brief")?.id).toBe("stages");
  expect(pageOfLegacy("particl", "brief", "home")?.id).toBe("home");
  /* Business opens on Image ads; Ads is gone, and an old `sp=ads` link is Image ads. */
  expect(pageOfLegacy("moleculr", "marketing")?.id).toBe("dtc");
  expect(pageOfLegacy("moleculr", "marketing", "setup")?.id).toBe("setup");
  expect(pageOfLegacy("moleculr", "marketing", "not-a-page")?.id).toBe("dtc");
  expect(pageOfLegacy("moleculr", "marketing", "ads")?.id).toBe("dtc");
  expect(pageAlias("business", "ads")).toBe("dtc");
  expect(pageAlias("business", "dtc") ?? pageAlias("studio", "ads") ?? pageAlias("business", null) ?? pageAlias("business", "toString")).toBeNull();
  expect(shellPage("business", "ads")?.id).toBe("dtc");
  expect(restorePage("business", "ads").id).toBe("dtc");
  expect(firstShellPage("business").id).toBe("dtc");
  expect(SHELL_SUITES.find((s) => s.id === "business")!.pages.some((p) => p.id === "ads")).toBe(false);
  expect(shellPage("business", "setup")).toMatchObject({ n: "02", title: "Setup items", hint: "Saved products, brand kit and reference ad" });
});

test("suite names and marks are the design's, verbatim, with Atomik renamed by the owner", () => {
  /* Owner decision, 21 September 2026: the Suites surface follows the design
     README's names; the never-name rule covers the legacy screens only.
     Owner, 28 September 2026: Atomik is "Just Atomik agent". */
  expect(SHELL_SUITES.map((s) => [s.mark, s.name])).toEqual([
    ["STUDIO", "Studio"],
    ["ADS", "Ads"],
    ["SOCIAL", "Social"],
    ["AGENT", "Atomik Agent"],
  ]);
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

test("⌘Z undoes the open project's newest step; another project's steps wait for their project", () => {
  let stack: UndoEntry[] = [];
  stack = pushUndo(stack, { label: "A: shot restored", undo: () => {}, projectId: "a" });
  stack = pushUndo(stack, { label: "B: take restored", undo: () => {}, projectId: "b" });
  /* In A, the newer B step is not A's to undo: A's own step comes back, and B's stays. */
  const inA = popUndo(stack, "a")!;
  expect(inA.entry.label).toBe("A: shot restored");
  expect(inA.rest.map((e) => e.label)).toEqual(["B: take restored"]);
  expect(canUndo(inA.rest, "a")).toBe(false);
  expect(popUndo(inA.rest, "a")).toBeNull();
  expect(canUndo(inA.rest, "b")).toBe(true);
  expect(popUndo(inA.rest, "b")!.entry.label).toBe("B: take restored");
  /* A step with no project belongs to every project; without a project id, the newest of all. */
  const loose = pushUndo(stack, { label: "anywhere", undo: () => {} });
  expect(popUndo(loose, "a")!.entry.label).toBe("anywhere");
  expect(popUndo(stack)!.entry.label).toBe("B: take restored");
});

test("a Rig step refuses while the Rig still holds another project's draft, and runs once A's draft is back", async () => {
  /* Delete in A, switch to B, back to A: until A's draft loads, the Rig holds B (or nothing). */
  let rig: string | null = "a";
  let restored = 0;
  const step = boundUndo({ label: "Shot 2 is back in the Rig", undo: () => { restored++; } }, "a", () => rig, "the Rig is still opening this project.");
  expect(step.projectId).toBe("a");
  rig = "b";
  expect(() => step.undo()).toThrow("the Rig is still opening this project.");
  rig = null;
  expect(() => step.undo()).toThrow();
  expect(restored).toBe(0);
  rig = "a";
  await step.undo();
  expect(restored).toBe(1);
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
  /* A Rig node lists what the Rig carries out for it: nothing wired → only Paste and Undo; the rest once the Rig registers them. */
  expect(commands(ctxItems({ kind: "node", id: "n" }, caps()))).toEqual(["paste", "—", "undo"]);
  expect(commands(ctxItems({ kind: "node", id: "n" }, caps({ can: { bypass: true, unplug: true } })))).toEqual(["paste", "—", "bypass", "unplug", "—", "undo"]);
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

test("a Rig node leaves out commands the Rig does not carry out, and keeps a blocked one that has its own reason", () => {
  /* What SuitesShell gives a node while the Rig is on screen, and while it is not. */
  const onRig = ctxItems({ kind: "node", id: "n" }, caps({ can: { delete: true }, why: { delete: "Open the Board to delete a shot." }, canUndo: true }));
  expect(commands(onRig)).toEqual(["paste", "—", "delete", "undo"]);
  expect(find(onRig, "delete").disabled).toBeFalsy();
  const offRig = ctxItems({ kind: "node", id: "n" }, caps({ why: { delete: "Open the Board to delete a shot." } }));
  expect(find(offRig, "delete")).toMatchObject({ disabled: true, reason: "Open the Board to delete a shot." });
  for (const gone of ["copy", "cut", "duplicate", "bypass", "unplug", "move", "retry"]) expect(onRig.some((i) => !i.sep && i.command === gone)).toBe(false);
  /* When Bypass is wired it appears, in the README's place. */
  expect(commands(ctxItems({ kind: "node", id: "n" }, caps({ can: { bypass: true, delete: true } })))).toEqual(["paste", "—", "bypass", "—", "delete", "undo"]);
  /* Assets still show every item, blocked ones with their reason. */
  expect(ctxItems({ kind: "asset", id: "a" }, caps()).filter((i) => !i.sep)).toHaveLength(10);
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

test("a lingering selection does not take ⌘C from selected text, nor ⌫/⌘R/⌘D from an unrelated button", () => {
  /* A stand-in element: `closest` answers for the selector the shell asks about. */
  const el = (tagName: string, inside: boolean) => ({ tagName, closest: (sel: string) => (inside && sel.includes("data-ctx") ? {} : null) }) as unknown as EventTarget;
  const libraryThumb = el("BUTTON", true), otherButton = el("BUTTON", false), body = el("BODY", false);
  expect(inSelectionSurface(libraryThumb)).toBe(true);
  expect(inSelectionSurface(otherButton)).toBe(false);
  expect(inSelectionSurface(null)).toBe(false);
  expect(shortcutApplies("copy", { target: libraryThumb, textSelected: false, selection: "asset" })).toBe(true);
  expect(shortcutApplies("copy", { target: body, textSelected: true, selection: "asset" })).toBe(false);
  expect(shortcutApplies("cut", { target: body, textSelected: true, selection: "asset" })).toBe(false);
  expect(shortcutApplies("paste", { target: body, textSelected: true, selection: "asset" })).toBe(true);
  expect(shortcutApplies("undo", { target: otherButton, textSelected: false, selection: "empty" })).toBe(true);
  for (const cmd of ["delete", "retry", "duplicate"] as const) {
    /* From the tile (Chrome focuses a clicked button). */
    expect(shortcutApplies(cmd, { target: libraryThumb, textSelected: false, selection: "asset" }), cmd).toBe(true);
    /* Another control has focus: the key is its, whatever was pressed last. */
    expect(shortcutApplies(cmd, { target: otherButton, textSelected: false, selection: "asset", pressedInSurface: true }), cmd).toBe(false);
    expect(shortcutApplies(cmd, { target: otherButton, textSelected: false, selection: "node", pressedInSurface: true }), cmd).toBe(false);
    /* Focus on the page. Safari and Firefox on macOS leave it there after a click on a tile, and the Rig canvas takes none:
       the last press decides. Pressed in the Library, Inspector or Rig: the selection's. Pressed anywhere else: the browser's (reload, bookmark). */
    expect(shortcutApplies(cmd, { target: body, textSelected: false, selection: "asset", pressedInSurface: true }), cmd).toBe(true);
    expect(shortcutApplies(cmd, { target: body, textSelected: false, selection: "node", pressedInSurface: true }), cmd).toBe(true);
    expect(shortcutApplies(cmd, { target: body, textSelected: false, selection: "asset", pressedInSurface: false }), cmd).toBe(false);
    expect(shortcutApplies(cmd, { target: body, textSelected: false, selection: "node" }), cmd).toBe(false);
  }
});

