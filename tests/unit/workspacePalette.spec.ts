import { test, expect } from "@playwright/test";
import { keyContextFor, legend, legendBindings, resolveKey, stepSelection, WORKSPACE_BINDINGS, type KeyBinding } from "../../lib/workspace/keys";
import { INITIAL_STATE } from "../../lib/workspace/navigation";
import { filterPalette, moveHighlight, paletteCommands, PALETTE_LIMIT } from "../../lib/workspace/palette";
import { PAGES } from "../../lib/workspace/pages";
import type { AppState } from "../../lib/workspace/types";

const shots = [
  { id: "s1", name: "Opening", status: "ready" },
  { id: "s2", name: "The turn", status: "draft" },
  { id: "s3", name: "Departure", status: "draft" },
];
const studio: AppState = { ...INITIAL_STATE, view: "studio", page: "rig", selKind: "shot", selId: "s2", lists: { shots, takes: null, cast: null } };
const ctx = (state: AppState, live = {}) => keyContextFor(state, live);

test("palette sources, in order: pages, run this page, plans, actions, shots, projects", () => {
  const all = paletteCommands({ shots });
  const pageCount = Object.values(PAGES).flat().length;
  expect(all.slice(0, pageCount).map((c) => c.action.type)).toEqual(Array(pageCount).fill("go"));
  expect(all.slice(0, 8).map((c) => c.label)).toEqual(PAGES.particl.map((p) => p.title));
  expect(new Set(all.slice(0, pageCount).map((c) => c.group))).toEqual(new Set(["STUDIO", "AGENT", "BUSINESS", "VIRAL"]));
  expect(all[pageCount]).toMatchObject({ group: "ATOMIK", label: "Run this page with Atomik", hint: "A" });
  const plans = all.filter((c) => c.action.type === "runPlan");
  expect(plans).toHaveLength(pageCount);
  expect(plans.every((c) => c.group === "ATOMIK")).toBe(true);
  expect(all.findIndex((c) => c.action.type === "runPlan")).toBe(pageCount + 1);
  const tail = all.slice(pageCount + 1 + plans.length);
  expect(tail.map((c) => `${c.group}:${c.label}:${c.hint}`)).toEqual([
    "ACTION:Generate selected shot:G",
    "ACTION:Toggle inspector:I",
    "SHOT:Opening:", "SHOT:The turn:", "SHOT:Departure:",
    "GO:All projects:",
  ]);
  /* No shots loaded: no shot rows, never fixture names. */
  expect(paletteCommands({ shots: null }).some((c) => c.group === "SHOT")).toBe(false);
});

test("filtering is a case-insensitive substring on label or group, capped at eight", () => {
  const all = paletteCommands({ shots });
  expect(filterPalette(all, "")).toHaveLength(PALETTE_LIMIT);
  expect(filterPalette(all, "")[0].label).toBe("Brief & Script");
  expect(filterPalette(all, "RIG")[0]).toMatchObject({ label: "Rig", group: "STUDIO" });
  expect(filterPalette(all, "  DEPART ").map((c) => c.label)).toEqual(["Departure"]);
  expect(filterPalette(all, "viral").every((c) => c.group === "VIRAL")).toBe(true);
  /* Group matches too: "atomik" finds the run-this-page row and plan titles. */
  expect(filterPalette(all, "atomik")[0].label).toBe("Run this page with Atomik");
  expect(filterPalette(all, "zzz")).toEqual([]);
  expect(moveHighlight(0, -1, 5)).toBe(0);
  expect(moveHighlight(0, 1, 5)).toBe(1);
  expect(moveHighlight(4, 1, 5)).toBe(4);
  expect(moveHighlight(3, 1, 0)).toBe(0);
});

test("⌘K / Ctrl+K works everywhere, including inside inputs; single keys bail while typing", () => {
  for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }, { tagName: "BODY" }]) {
    expect(resolveKey(WORKSPACE_BINDINGS, { key: "k", metaKey: true, target }, ctx(studio))?.id).toBe("palette");
    expect(resolveKey(WORKSPACE_BINDINGS, { key: "K", ctrlKey: true, target }, ctx(INITIAL_STATE))?.id).toBe("palette");
  }
  const typing = { tagName: "INPUT" };
  for (const key of ["g", "i", "a", " ", "1", "ArrowLeft", "ArrowRight", "Escape"])
    expect(resolveKey(WORKSPACE_BINDINGS, { key, target: typing }, ctx(studio, { canGenerate: true, canPlay: true }))).toBeNull();
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "Enter", target: typing }, ctx(INITIAL_STATE))).toBeNull();
  /* Plain k is not the palette; ⌘G is the browser's. */
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "k" }, ctx(studio))).toBeNull();
  expect(resolveKey(WORKSPACE_BINDINGS, { key: "g", metaKey: true }, ctx(studio))).toBeNull();
});

test("the keymap: Enter on home, 1–9, ← →, G, I, A, Space, Esc", () => {
  const body = { tagName: "BODY" };
  const on = (key: string, state: AppState = studio, live: { canGenerate?: boolean; canPlay?: boolean } = { canGenerate: true, canPlay: true }, target: { tagName: string } = body) =>
    resolveKey(WORKSPACE_BINDINGS, { key, target }, ctx(state, live));
  expect(on("Enter", INITIAL_STATE)?.action({ key: "Enter" }, ctx(INITIAL_STATE))).toEqual({ type: "enterStudio" });
  expect(on("Enter", INITIAL_STATE, {}, { tagName: "BUTTON" })).toBeNull();
  expect(on("Enter")).toBeNull();
  expect(on("3")?.id).toBe("stage");
  expect(on("ArrowRight")?.action({ key: "ArrowRight" }, ctx(studio))).toEqual({ type: "item", step: 1 });
  expect(on("ArrowLeft")?.action({ key: "ArrowLeft" }, ctx(studio))).toEqual({ type: "item", step: -1 });
  expect(on("ArrowRight", { ...studio, page: "brief", selKind: "page" })).toBeNull();
  expect(on("g")?.id).toBe("generate");
  expect(on("G")?.id).toBe("generate");
  expect(on("i")?.id).toBe("inspector");
  expect(on("a")?.id).toBe("atomik");
  expect(on(" ")?.id).toBe("play");
  expect(on(" ", studio, { canGenerate: true, canPlay: false })).toBeNull();
  expect(on("Escape")?.id).toBe("escape");
  /* Nothing single-key reaches the shell from under an open palette. */
  for (const key of ["a", "g", " ", "ArrowRight"]) expect(on(key, { ...studio, palette: true })).toBeNull();
  expect(on("a", INITIAL_STATE)).toBeNull();
});

test("← → walk the selection's own visible list, wrapping", () => {
  expect(stepSelection(shots, "s2", 1)).toBe("s3");
  expect(stepSelection(shots, "s3", 1)).toBe("s1");
  expect(stepSelection(shots, "s1", -1)).toBe("s3");
  expect(stepSelection(shots, "gone", 1)).toBe("s1");
  expect(stepSelection([], "s1", 1)).toBeNull();
  /* Takes respect the active filter: → never lands on a hidden card. */
  const takes = [
    { id: "u1", name: "Scout", kind: "upload" as const },
    { id: "g1", name: "Opening v2", kind: "generation" as const },
    { id: "u2", name: "Wind test", kind: "upload" as const },
  ];
  const onTakes: AppState = { ...studio, page: "takes", selKind: "take", selId: "u1", libFilter: "Uploads", lists: { shots: null, takes, cast: null } };
  expect(keyContextFor(onTakes).selectionCount).toBe(2);
});

test("the status bar legend lists exactly the live keys, ⌘K last", () => {
  const bindings = legendBindings() as KeyBinding<unknown>[];
  expect(legend(bindings, ctx(studio, { canGenerate: true, canPlay: true }))).toEqual([
    { key: "1–8", label: "stage" }, { key: "← →", label: "item" }, { key: "A", label: "atomik" },
    { key: "G", label: "generate" }, { key: "I", label: "inspector" }, { key: "Space", label: "play" },
    { key: "⌘K", label: "commands" },
  ]);
  expect(legend(bindings, ctx({ ...studio, page: "brief", selKind: "page" }))).toEqual([
    { key: "1–8", label: "stage" }, { key: "A", label: "atomik" }, { key: "I", label: "inspector" }, { key: "⌘K", label: "commands" },
  ]);
});
