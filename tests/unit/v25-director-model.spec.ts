import { test, expect } from "@playwright/test";
import { NO_ENGINE_NOTE, SHOTS_SETTINGS, barButton, modelWords, cancellable, cardChips, failureWords, nextStepLabel, pressPrice, retryPrice, requestFields, scopeOf, shotSettings, valueWords } from "../../components/v12/board/director-model";
import { CREDITS_MODE, FREE, NO_AT_COST_FIGURE, priceWords } from "../../lib/shell/price-words";
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

test("Director never picks an engine: the model line reads None until the person picks one (owner, 16 Oct 2026, 2a)", () => {
  expect(modelWords(null)).toBe("None");
  expect(modelWords(undefined)).toBe("None");
  expect(modelWords({ id: "x", label: "Seedance 2.5" })).toBe("Seedance 2.5");
  expect(modelWords(null)).not.toMatch(/auto/i);
  expect(NO_ENGINE_NOTE).toBe("Pick an engine first.");
});

test("a press's price: its total in credits, a ceiling as \"up to\", and in the house a ceiling reads at a credit's public price, never \"—\"", () => {
  /* Synthetic figures, built here: the press's quote as the batch route answers it. */
  const HOUSE = { on: true, creditUsd: 0.1 } as const;
  expect(priceWords(pressPrice({ estimatedCredits: 172, unit: "cr", price: 172 }), CREDITS_MODE)).toBe("172 cr");
  expect(priceWords(pressPrice({ estimatedCredits: 172, ceilingCredits: 240, unit: "cr", price: 172 }), CREDITS_MODE)).toBe("up to 240 cr");
  /* The house pays at cost in dollars: an estimate reads its own dollars; a ceiling, which the route gives only in credits, reads as a hold. */
  expect(priceWords(pressPrice({ estimatedCredits: 172, unit: "usd", price: 4.3 }), HOUSE)).toBe("$4.30");
  const ceiling = priceWords(pressPrice({ estimatedCredits: 172, ceilingCredits: 240, unit: "usd", price: 4.3 }), HOUSE);
  expect(ceiling).not.toBe(NO_AT_COST_FIGURE);
  expect(ceiling).toBe("up to $24.00");
  /* No figure, no price: never a zero or a guess. */
  expect(pressPrice({ estimatedCredits: Number.NaN })).toBeNull();
});

test("Retry's price is the press's own approval as a ceiling, read as the press's price reads: in the house its dollars at cost, never credits at a credit's price", () => {
  /* Synthetic figures, built here. */
  const HOUSE = { on: true, creditUsd: 0.1 } as const;
  expect(priceWords(retryPrice(pressPrice({ estimatedCredits: 172, unit: "cr", price: 172 })), CREDITS_MODE)).toBe("up to 172 cr");
  /* The house: an estimate at cost ($4.30) reads "up to $4.30", not 172 credits at $0.10. */
  expect(priceWords(retryPrice(pressPrice({ estimatedCredits: 172, unit: "usd", price: 4.3 })), HOUSE)).toBe("up to $4.30");
  /* A ceiling stays the hold it is. */
  expect(priceWords(retryPrice(pressPrice({ estimatedCredits: 172, ceilingCredits: 240, unit: "usd", price: 4.3 })), HOUSE)).toBe("up to $24.00");
  expect(retryPrice(null)).toBeNull();
  expect(retryPrice(FREE)).toBeNull();
});

test("a failed take's line on the Director's bar says \"Nothing billed\" where the shared line says \"Not billed\" or \"Not charged\"; a charge keeps its figure", () => {
  /* Synthetic failures, as the jobs route sends them with the ledger's charge. */
  const failure = (charge: { credits: number; settled: boolean; released?: true }) => ({ provider: null, stage: null, code: "unknown", kind: "unknown" as const, message: null, billing: null, payer: null, charge });
  const free = failureWords(failure({ credits: 0, settled: true }), false);
  expect(free).toContain("Nothing billed");
  expect(free).not.toContain("Not billed");
  /* A held take whose hold came back whole: the shared line says "Not charged". */
  const released = failureWords(failure({ credits: 0, settled: true, released: true }), false);
  expect(released).toContain("Nothing billed");
  expect(released).not.toContain("Not charged");
  expect(failureWords(failure({ credits: 43, settled: true }), false)).toContain("43 cr charged");
  expect(failureWords(null, true)).toBe("Cancelled");
  expect(failureWords(undefined, false)).toBe("Failed");
});
