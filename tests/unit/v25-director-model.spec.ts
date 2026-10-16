import { test, expect } from "@playwright/test";
import { SHOTS_SETTINGS, barButton, cancellable, cardChips, nextStepLabel, requestFields, scopeOf, shotSettings, valueWords } from "../../components/v12/board/director-model";
import { stagesOf } from "../../lib/v12/board/stages";

/* v25 PR 7: Director on Shots (components/v12/board/director-model.ts). Pure. */
const SHOTS = [{ id: "s1", name: "Shot 1" }, { id: "s2", name: "Shot 2" }, { id: "s4", name: "Shot 4" }];

test("scope: no selection is every shot; one is named; several are counted; the same words everywhere", () => {
  expect(scopeOf([], SHOTS)).toMatchObject({ all: true, label: "All 3 shots", short: "3 shots", ids: ["s1", "s2", "s4"] });
  expect(scopeOf(["s4"], SHOTS)).toMatchObject({ all: false, label: "Shot 4", short: "Shot 4", ids: ["s4"] });
  expect(scopeOf(["s1", "s4", "zzz"], SHOTS)).toMatchObject({ label: "2 shots", ids: ["s1", "s4"] });
  expect(scopeOf(["zzz"], SHOTS).all).toBe(true);
  expect(scopeOf([], [{ id: "a", name: "Shot 1" }]).label).toBe("All 1 shot");
});

test("the bar's one button: what pressing it makes, Making…, then the way on", () => {
  const all = scopeOf([], SHOTS), one = scopeOf(["s4"], SHOTS);
  expect(barButton({ state: "idle", scope: all, next: "Edit" })).toBe("Render 3 shots");
  expect(barButton({ state: "idle", scope: one, next: "Edit" })).toBe("Render Shot 4");
  expect(barButton({ state: "sending", scope: one, next: "Edit" })).toBe("Making…");
  expect(barButton({ state: "making", scope: all, next: "Edit" })).toBe("Making…");
  expect(barButton({ state: "done", scope: all, next: "Edit" })).toBe("Next: Edit →");
  expect(barButton({ state: "done", scope: all, next: null })).toBe("Done");
});

test("the settings: Director's defaults, the step's setup, then a card's own; a value the item does not offer falls back", () => {
  expect(shotSettings({}, null)).toEqual({ quality: "final", length: 5, ratio: "16:9", sound: false });
  const draft = { boardSetup: { director: { shots: { quality: "draft", length: 6 } } }, boardOverrides: { s4: { length: 8, ratio: "9:16" } } };
  expect(shotSettings(draft, null)).toEqual({ quality: "draft", length: 6, ratio: "16:9", sound: false });
  expect(shotSettings(draft, "s4")).toEqual({ quality: "draft", length: 8, ratio: "9:16", sound: false });
  expect(shotSettings({ boardSetup: { director: { shots: { length: 7, quality: "ultra" } } } }, null)).toMatchObject({ length: 5, quality: "final" });
  /* Agent's setup is its own and never read here. */
  expect(shotSettings({ boardSetup: { agent: { shots: { quality: "draft" } } } }, null).quality).toBe("final");
});

test("what a setting set means for a request: draft is 480p and flagged, final is 1080p", () => {
  expect(requestFields({ quality: "draft", length: 4, ratio: "9:16", sound: true })).toEqual({ resolution: "480p", draft: true, duration: 4, ratio: "9:16", generateAudio: true });
  expect(requestFields({ quality: "final", length: 5, ratio: "16:9", sound: false })).toEqual({ resolution: "1080p", draft: false, duration: 5, ratio: "16:9", generateAudio: false });
  expect(requestFields({}).duration).toBe(5);
});

test("chips appear only where a card differs from its step", () => {
  const draft = { boardSetup: { director: { shots: { length: 6 } } }, boardOverrides: { s4: { length: 8, quality: "draft" }, s5: { length: 6 } } };
  expect(cardChips(draft, "s4")).toEqual([{ id: "quality", label: "Draft" }, { id: "length", label: "8 s" }]);
  expect(cardChips(draft, "s5")).toEqual([]);
  expect(cardChips(draft, "s1")).toEqual([]);
  expect(cardChips({ boardOverrides: { s2: { sound: true } } }, "s2")).toEqual([{ id: "sound", label: "Sound" }]);
});

test("every item has a default among its choices; values read in words", () => {
  for (const item of SHOTS_SETTINGS) expect(item.choices.some((c) => c.value === item.default), item.id).toBe(true);
  expect(valueWords(SHOTS_SETTINGS[1], 6)).toBe("6 s");
  expect(valueWords(SHOTS_SETTINGS[0], "nope")).toBe("Final");
});

test("Next is the step after this one that is not skipped; a removed step is not on the rail at all", () => {
  const rail = stagesOf("film", null);
  expect(nextStepLabel(rail, "shots")).toBe("Edit");
  expect(nextStepLabel(rail, "deliver")).toBeNull();
  expect(nextStepLabel(rail, "nope")).toBeNull();
  const skipped = stagesOf("film", rail.map((s) => ({ id: s.id, skipped: s.id === "edit" })));
  expect(nextStepLabel(skipped, "shots")).toBe("Deliver");
  const removed = stagesOf("film", rail.map((s) => (s.id === "edit" ? { id: s.id, removed: true } : { id: s.id })));
  expect(removed.some((s) => s.id === "edit")).toBe(false);
  expect(nextStepLabel(removed, "shots")).toBe("Deliver");
});

test("Cancel is offered only while a take is still queued at the provider", () => {
  expect(cancellable([])).toBe(false);
  expect(cancellable(["running"])).toBe(false);
  expect(cancellable(["running", "queued"])).toBe(true);
  expect(cancellable(["succeeded", "failed"])).toBe(false);
});
