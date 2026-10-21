import { test, expect } from "@playwright/test";
import {
  CLAIMS_KEPT, NO_ENGINE_NOTE, PRESS_LIMIT_NOTE, PRESS_MAX_SHOTS, SHOTS_SETTINGS, barButton, claimLive, failureCharged, failureNote, modelWords, cancellable, cardChips, failureWords,
  letGo, nextStepLabel, pressPrice, readClaim, readClaims, retryPrice, requestFields, scopeOf, shotSettings, validToStart, valueWords, writeClaim, type PressClaim,
} from "../../components/v12/board/director-model";
import { CREDITS_MODE, FREE, NO_AT_COST_FIGURE, priceWords } from "../../lib/shell/price-words";
import { stagesOf } from "../../lib/v12/board/stages";
import { BATCH_MAX_MEMBERS } from "../../lib/batchPress";
import { PLAN_APPROVAL_MS } from "../../lib/workbench/plan-approval";

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

test("a press takes at most as many shots as a plan renders at once, the batch route's own bound; past it the bar says so in the plan's words", () => {
  expect(PRESS_MAX_SHOTS).toBe(24);
  expect(PRESS_MAX_SHOTS, "the client's bound is the route's").toBe(BATCH_MAX_MEMBERS);
  expect(PRESS_LIMIT_NOTE).toBe("Up to 24 shots at a time. Pick some.");
});

test("Retry's price is only the shots still to start, as the route quotes them under the press's key (toStart); without that figure, or with none left, the whole approval", () => {
  /* Synthetic figures, built here: a press of four shots approved at 172 cr, and what the batch route would say is left. */
  const HOUSE = { on: true, creditUsd: 0.1 } as const;
  const whole = pressPrice({ estimatedCredits: 172, unit: "cr", price: 172 });
  expect(priceWords(retryPrice(whole, { members: 1, estimatedCredits: 43, price: 43, unit: "cr" }), CREDITS_MODE)).toBe("43 cr");
  expect(priceWords(retryPrice(whole, { members: 2, estimatedCredits: 86, price: 86, unit: "cr" }), CREDITS_MODE)).toBe("86 cr");
  /* A shot left that holds a ceiling: "up to". */
  expect(priceWords(retryPrice(whole, { members: 1, estimatedCredits: 43, ceilingCredits: 60, unit: "cr" }), CREDITS_MODE)).toBe("up to 60 cr");
  /* The house: the shots' own dollars at cost. */
  expect(priceWords(retryPrice(pressPrice({ estimatedCredits: 172, unit: "usd", price: 4.3 }), { members: 1, estimatedCredits: 43, price: 1.05, unit: "usd" }), HOUSE)).toBe("$1.05");
  /* Today's route sends no toStart: the whole approval, as before. So does a figure that is not one, or none left. */
  expect(priceWords(retryPrice(whole), CREDITS_MODE)).toBe("up to 172 cr");
  expect(priceWords(retryPrice(whole, null), CREDITS_MODE)).toBe("up to 172 cr");
  expect(priceWords(retryPrice(whole, { members: 0, estimatedCredits: 0, unit: "cr" }), CREDITS_MODE)).toBe("up to 172 cr");
  expect(priceWords(retryPrice(whole, { members: 1, estimatedCredits: -43 }), CREDITS_MODE)).toBe("up to 172 cr");
  expect(priceWords(retryPrice(whole, { members: 1, estimatedCredits: 43, ceilingCredits: 10 }), CREDITS_MODE)).toBe("up to 172 cr");
  expect(priceWords(retryPrice(whole, { estimatedCredits: 43 }), CREDITS_MODE)).toBe("up to 172 cr");
  expect(validToStart({ members: 1, estimatedCredits: 43 })).toBe(true);
  expect(validToStart({ members: 1.5, estimatedCredits: 43 })).toBe(false);
  expect(retryPrice(FREE, { members: 1, estimatedCredits: 43 })).toBeNull();
});

test("a failed take is charged only when Particl's ledger settled it above nothing; the lines read one after another", () => {
  const failure = (charge: { credits: number; settled: boolean } | null) => ({ provider: null, stage: null, code: "unknown", kind: "unknown" as const, message: null, billing: null, payer: null, charge });
  expect(failureCharged(failure({ credits: 43, settled: true }))).toBe(true);
  expect(failureCharged(failure({ credits: 0, settled: true }))).toBe(false);
  expect(failureCharged(failure({ credits: 43, settled: false })), "a hold not yet settled is not a charge").toBe(false);
  expect(failureCharged(failure(null))).toBe(false);
  expect(failureCharged(null)).toBe(false);
  expect(failureNote([])).toBeNull();
  expect(failureNote([{ name: "Shot 2", words: "Did not render · Nothing billed · Render again" }, { name: "Shot 3", words: "Failed." }]))
    .toBe("Shot 2: Did not render · Nothing billed · Render again. Shot 3: Failed.");
});

test("a held approval lasts as a plan's does (7 days): past it the claim is dropped, so the next press is quoted afresh and approved again", () => {
  expect(PLAN_APPROVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  /* A synthetic approval, built here. */
  const quote = { estimatedCredits: 172, unit: "cr", price: 172, members: 4, fingerprint: "a".repeat(64) };
  const t0 = 1_800_000_000_000;
  const claim = (key: string, shots: string, at: number): PressClaim => ({ key, shots, quote, answered: false, at });
  writeClaim(storage, "slot", claim("k1", "s1", t0), t0);
  expect(readClaim(storage, "slot", "s1", t0 + PLAN_APPROVAL_MS - 1)?.key).toBe("k1");
  expect(readClaim(storage, "slot", "s1", t0 + PLAN_APPROVAL_MS), "seven days on: past its time").toBeNull();
  expect(claimLive({ at: t0 }, t0 + PLAN_APPROVAL_MS)).toBe(false);
  expect(claimLive({ at: Number.NaN }, t0)).toBe(false);
  /* A claim with no time of approval is past it. */
  store.set("old", JSON.stringify({ claims: [{ key: "k0", shots: "s0", quote, answered: false }] }));
  expect(readClaims(storage, "old", t0)).toEqual([]);
  /* A new claim written after the first ran out leaves the old one behind, and the newest CLAIMS_KEPT stay. */
  writeClaim(storage, "slot", claim("k2", "s2", t0 + PLAN_APPROVAL_MS), t0 + PLAN_APPROVAL_MS);
  expect(JSON.parse(store.get("slot")!).claims.map((c: PressClaim) => c.key)).toEqual(["k2"]);
  for (let i = 0; i < CLAIMS_KEPT + 2; i++) writeClaim(storage, "slot", claim(`n${i}`, `x${i}`, t0 + PLAN_APPROVAL_MS), t0 + PLAN_APPROVAL_MS);
  expect(readClaims(storage, "slot", t0 + PLAN_APPROVAL_MS)).toHaveLength(CLAIMS_KEPT);
  letGo(storage, "slot", `n${CLAIMS_KEPT + 1}`, t0 + PLAN_APPROVAL_MS);
  expect(readClaims(storage, "slot", t0 + PLAN_APPROVAL_MS).map((c) => c.key)).not.toContain(`n${CLAIMS_KEPT + 1}`);
});
