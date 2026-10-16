import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { BOARD_DATA_LIMITS, BOARD_MODES, DEFAULT_BOARD_MODE, cardOverrides, effectiveSetup, modeOf, overriddenKeys, stepSetup, withCardOverride, withMode, withStepSetting, withoutCardOverrides, type BoardModes } from "../../lib/v12/board/board-data";
import { newProject } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";

/**
 * What a v25 board keeps in its draft beside its stages (lib/v12/board/board-data.ts): the mode each person works in, each
 * mode's setup per step, and a card's own overrides. Pure; the draft's schema takes exactly this.
 */

test("a person's mode is theirs alone: another person's choice never changes it, and a person who has not chosen is in Agent", () => {
  expect(DEFAULT_BOARD_MODE).toBe("agent");
  expect(BOARD_MODES).toEqual(["agent", "director"]);
  expect(modeOf(undefined, "ana")).toBe("agent");
  expect(modeOf({}, null)).toBe("agent");
  let modes: BoardModes = withMode(undefined, "ana", "director");
  expect(modeOf(modes, "ana")).toBe("director");
  expect(modeOf(modes, "ben")).toBe("agent");
  modes = withMode(modes, "ben", "agent");
  modes = withMode(modes, "ana", "agent");
  expect(modes).toEqual({ ben: "agent", ana: "agent" });
  expect(modeOf(withMode(modes, "ben", "director"), "ana")).toBe("agent");
  /* Inherited names are not people. */
  expect(modeOf({}, "constructor")).toBe("agent");
  expect(modeOf({}, "__proto__")).toBe("agent");
});

test("a mode or person the draft would refuse leaves the modes as they were; the oldest choice is let go past the limit", () => {
  const modes: BoardModes = { ana: "director" };
  expect(withMode(modes, "has space", "director")).toBe(modes);
  expect(withMode(modes, "", "director")).toBe(modes);
  expect(withMode(modes, "ben", "ask" as never)).toBe(modes);
  expect(withMode(modes, "ben", "auto" as never)).toBe(modes);
  let many: BoardModes = {};
  for (let i = 0; i < BOARD_DATA_LIMITS.people + 5; i++) many = withMode(many, `p${i}`, "director");
  expect(Object.keys(many)).toHaveLength(BOARD_DATA_LIMITS.people);
  expect(many.p0).toBeUndefined();
  expect(many[`p${BOARD_DATA_LIMITS.people + 4}`]).toBe("director");
  expect(projectSchema.safeParse({ ...newProject("Board"), boardMode: many }).success).toBe(true);
});

test("each mode keeps its own setup for each step, and clearing the last setting leaves nothing behind", () => {
  let setup = withStepSetting(undefined, "director", "shots", "quality", "final");
  setup = withStepSetting(setup, "director", "shots", "length", 5);
  setup = withStepSetting(setup, "agent", "shots", "quality", "draft");
  setup = withStepSetting(setup, "director", "cast", "sound", true);
  expect(stepSetup(setup, "director", "shots")).toEqual({ quality: "final", length: 5 });
  expect(stepSetup(setup, "agent", "shots")).toEqual({ quality: "draft" });
  expect(stepSetup(setup, "agent", "cast")).toEqual({});
  /* A read is a copy. */
  stepSetup(setup, "director", "shots").quality = "x";
  expect(stepSetup(setup, "director", "shots").quality).toBe("final");
  const before = JSON.stringify(setup);
  setup = withStepSetting(setup, "director", "shots", "quality", null);
  expect(stepSetup(setup, "director", "shots")).toEqual({ length: 5 });
  expect(JSON.stringify(setup)).not.toBe(before);
  setup = withStepSetting(setup, "director", "shots", "length", null);
  setup = withStepSetting(setup, "director", "cast", "sound", null);
  expect(setup).toEqual({ agent: { shots: { quality: "draft" } } });
  expect(withStepSetting(setup, "agent", "shots", "quality", null)).toEqual({});
});

test("a setting the draft would refuse leaves the setup as it was", () => {
  const setup = withStepSetting(undefined, "director", "shots", "quality", "final");
  expect(withStepSetting(setup, "director", "bad step", "quality", "x")).toBe(setup);
  expect(withStepSetting(setup, "director", "shots", "1bad", "x")).toBe(setup);
  expect(withStepSetting(setup, "director", "shots", "quality", Number.NaN)).toBe(setup);
  expect(withStepSetting(setup, "director", "shots", "quality", { a: 1 })).toBe(setup);
  expect(withStepSetting(setup, "ask" as never, "shots", "quality", "x")).toBe(setup);
  expect(stepSetup(withStepSetting(setup, "director", "shots", "note", `  ${"x".repeat(500)}  `), "director", "shots").note).toHaveLength(BOARD_DATA_LIMITS.text);
  let full = setup;
  for (let i = 0; i < BOARD_DATA_LIMITS.settings + 3; i++) full = withStepSetting(full, "director", "shots", `k${i}`, i);
  expect(Object.keys(stepSetup(full, "director", "shots"))).toHaveLength(BOARD_DATA_LIMITS.settings);
  let steps = setup;
  for (let i = 0; i < BOARD_DATA_LIMITS.steps + 3; i++) steps = withStepSetting(steps, "director", `step${i}`, "a", 1);
  expect(Object.keys(steps.director!)).toHaveLength(BOARD_DATA_LIMITS.steps);
  expect(projectSchema.safeParse({ ...newProject("Board"), boardSetup: steps }).success).toBe(true);
});

test("a card's own overrides sit on top of its step's setup, in the open mode, and clearing them returns to the step", () => {
  let draft: { boardSetup?: ReturnType<typeof withStepSetting>; boardOverrides?: ReturnType<typeof withCardOverride> } = {};
  draft.boardSetup = withStepSetting(draft.boardSetup, "director", "shots", "quality", "draft");
  draft.boardSetup = withStepSetting(draft.boardSetup, "director", "shots", "length", 5);
  draft.boardSetup = withStepSetting(draft.boardSetup, "agent", "shots", "length", 8);
  draft.boardOverrides = withCardOverride(draft.boardOverrides, "shot:4", "quality", "final");
  draft.boardOverrides = withCardOverride(draft.boardOverrides, "shot:4", "length", 5);
  const at = { mode: "director" as const, step: "shots", card: "shot:4" };
  expect(effectiveSetup(draft, at)).toEqual({ quality: "final", length: 5 });
  expect(effectiveSetup(draft, { ...at, card: "shot:5" })).toEqual({ quality: "draft", length: 5 });
  expect(effectiveSetup(draft, { ...at, mode: "agent" })).toEqual({ length: 5, quality: "final" });
  expect(effectiveSetup(draft, { mode: "agent", step: "shots" })).toEqual({ length: 8 });
  /* Only a differing value is the card's own. */
  expect(overriddenKeys(draft, at)).toEqual(["quality"]);
  draft.boardOverrides = withCardOverride(draft.boardOverrides, "shot:4", "quality", null);
  expect(cardOverrides(draft.boardOverrides, "shot:4")).toEqual({ length: 5 });
  expect(withoutCardOverrides(draft.boardOverrides, "shot:4")).toEqual({});
  expect(withCardOverride(draft.boardOverrides, "shot:4", "length", null)).toEqual({});
  expect(withCardOverride({}, "bad id", "a", 1)).toEqual({});
});

test("overrides keep to the card limit and the draft's schema takes exactly what the helpers write", () => {
  let overrides = {};
  for (let i = 0; i < BOARD_DATA_LIMITS.cards + 3; i++) overrides = withCardOverride(overrides, `shot:${i}`, "length", i);
  expect(Object.keys(overrides)).toHaveLength(BOARD_DATA_LIMITS.cards);
  const project = newProject("Board");
  const good = { ...project, boardMode: { ana: "director" }, boardSetup: { agent: { shots: { quality: "draft" } }, director: { shots: { length: 5, sound: true } } }, boardOverrides: { "shot:4": { quality: "final" } } };
  expect(projectSchema.safeParse(good).success).toBe(true);
  expect(projectSchema.safeParse({ ...good, boardOverrides: overrides }).success).toBe(true);
  for (const bad of [
    { boardMode: { ana: "ask" } }, { boardMode: { ana: "auto" } }, { boardMode: { "a b": "agent" } }, { boardMode: "director" },
    { boardSetup: { ask: {} } }, { boardSetup: { agent: { "bad step": {} } } }, { boardSetup: { agent: { shots: { "1k": 1 } } } },
    { boardSetup: { agent: { shots: { k: { nested: 1 } } } } }, { boardSetup: { agent: { shots: { k: "x".repeat(201) } } } },
    { boardOverrides: { "bad id": { a: 1 } } }, { boardOverrides: { "shot:4": { a: [1] } } },
  ]) expect(projectSchema.safeParse({ ...project, ...bad }).success, JSON.stringify(bad)).toBe(false);
});

/* A board's mode is how it is worked. Ask and Auto is a spending setting (rule 14) with its own name and place; the two
   never share a word in code (docs/plans/v25-build-plan.md risk 3). */
test("the board's mode is not Atomik's Ask and Auto spending setting: they share no name, value or file", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  const board = read("lib/v12/board/board-data.ts");
  expect(board).not.toMatch(/agentMode|AgentMode/);
  expect(board).not.toMatch(/["'](ask|auto)["']/);
  expect(read("lib/atomik.ts")).not.toMatch(/boardMode|BoardMode/);
  expect(read("lib/workbench/rig-agent-limits.ts")).not.toMatch(/boardMode|BoardMode/);
  const schema = read("lib/workbench/studio-schema.ts");
  expect(schema).not.toMatch(/agentMode/);
  expect(schema).toMatch(/boardMode: z\.record/);
  for (const mode of BOARD_MODES) expect(["ask", "auto"]).not.toContain(mode);
});
