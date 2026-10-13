import { test, expect } from "@playwright/test";
import { BUILT_IN_ROWS, commandOf, matchRows, needsWords, previewQuote, scopedFresh, skillRows, slugFor, typingSlash } from "../../lib/v12/skills";
import { UNPRICED } from "../../lib/v12/unpriced";
import type { SkillRunPreview, SkillRunStep, SkillView } from "../../lib/atomikSkillsText";

/**
 * The "/" skills list as data (lib/v12/skills.ts): which rows exist, how a typed command matches them, how a made command is read,
 * and what a saved skill's free preview says as a price. No figure is written here: the built-ins' prices are the engines
 * route's, drawn by the screen, and a saved skill's is the sum of its preview's estimates.
 */
const saved = (slug: string, name: string, over: Partial<SkillView> = {}): SkillView => ({
  id: `skill_${slug}`, slug, name, description: `${name} for a product`, scope: "workspace", status: "active", version: 1, byYou: true, byName: null,
  editedByYou: true, editedByName: null, archivedByYou: false, archivedByName: null, archivedAt: null, createdAt: 1, updatedAt: 2,
  template: { steps: [], parameters: [] } as never, canChangeScope: true, ...over,
});
const step = (over: Partial<SkillRunStep>): SkillRunStep => ({ index: 0, kind: "image", title: "A still", prompt: "x", model: "m", label: "M", params: {} as never, estCredits: 2, estUsd: null, swapped: false, ...over });
const preview = (steps: SkillRunStep[], problems: SkillRunPreview["problems"] = []): SkillRunPreview => ({ steps, problems, values: {} });

test("the built-ins are the Campaign formats that exist, in the Formats stage's order, each with its own command", () => {
  expect(BUILT_IN_ROWS.map((r) => r.slug)).toEqual(["product-video-ad", "talking-review", "unboxing", "try-on", "tutorial", "product-voice-over", "website-walk-through", "photoshoot"]);
  expect(slugFor("Website walk-through")).toBe("website-walk-through");
  /* Nothing the prototype lists for Social or Variants is invented here. */
  for (const word of ["captions", "thumbnails", "narrated", "narrator", "cast-sheet", "brand-assets", "ad-versions", "edit"]) expect(BUILT_IN_ROWS.some((r) => r.slug.includes(word))).toBe(false);
});

test("saved skills come first, and a saved skill takes a built-in's command from it", () => {
  const rows = skillRows([saved("wave-runner-spot", "Wave runner spot"), saved("unboxing", "My unboxing")]);
  expect(rows.slice(0, 2).map((r) => [r.kind, r.slug])).toEqual([["saved", "wave-runner-spot"], ["saved", "unboxing"]]);
  expect(rows.filter((r) => r.slug === "unboxing")).toHaveLength(1);
  expect(rows).toHaveLength(2 + BUILT_IN_ROWS.length - 1);
  expect(skillRows([])).toHaveLength(BUILT_IN_ROWS.length);
});

test("a command being typed lists the best matches first; a made command is read with its words", () => {
  const rows = skillRows([saved("wave-runner-spot", "Wave runner spot")]);
  expect(typingSlash("/")).toBe(true);
  expect(typingSlash("/unb")).toBe(true);
  expect(typingSlash("/unboxing ")).toBe(false);
  expect(typingSlash("unboxing")).toBe(false);
  expect(matchRows("/", rows).length).toBe(rows.length);
  expect(matchRows("/tut", rows).map((r) => r.slug)).toEqual(["tutorial"]);
  expect(matchRows("/review", rows).map((r) => r.slug)).toEqual(["talking-review"]);
  expect(matchRows("/zzz", rows)).toEqual([]);
  expect(matchRows("/unboxing", rows)[0].slug).toBe("unboxing");
  expect(commandOf("/unboxing", rows)?.row.slug).toBe("unboxing");
  expect(commandOf("/Unboxing  a clay bowl", rows)).toMatchObject({ rest: "a clay bowl" });
  expect(commandOf("/nothing", rows)).toBeNull();
  expect(commandOf("unboxing", rows)).toBeNull();
});

test("a saved skill's price is its preview's estimates added up, 'up to', and never a guess", () => {
  expect(previewQuote(preview([step({ estCredits: 2 }), step({ index: 1, estCredits: 5 })]))).toMatchObject({ state: "ready", price: { unit: "cr", value: { kind: "up-to", credits: 7 } } });
  /* A step with no list rate (a voice line, a library step) leaves the whole skill unpriced until its run form is filled in. */
  expect(previewQuote(preview([step({ estCredits: 2 }), step({ index: 1, estCredits: null })]))).toEqual({ reason: "skillPriceStep" });
  /* An engine that needs a choice says so: its hover names the engine, not the words. */
  expect(previewQuote(preview([step({})], [{ index: 0, title: "x", reason: "off" } as never]))).toEqual({ reason: "skillPriceEngine" });
  expect(previewQuote(preview([]))).toEqual({ reason: "skillPriceStep" });
  /* The house workspace pays in dollars. */
  expect(previewQuote(preview([step({ estCredits: null, estUsd: 0.5 }), step({ index: 1, estCredits: null, estUsd: 0.25 })]))).toEqual({ state: "ready", price: { unit: "usd", usd: 0.75, upTo: true } });
  expect(previewQuote(preview([step({ estCredits: 0 })]))).toMatchObject({ state: "ready", price: { unit: "cr", value: { kind: "free" } } });
});

test("a blank parameter is not a fault, and the one new 'quoted' reason is listed with its why", () => {
  expect(needsWords("Fill in The product.")).toBe(true);
  expect(needsWords("The skill could not be previewed. Try again.")).toBe(false);
  for (const id of ["skillPriceWords", "skillPriceEngine", "skillPriceStep"] as const) {
    expect(UNPRICED[id].why, id).toMatch(/dryRun/);
    expect(UNPRICED[id].hover.length, id).toBeGreaterThan(10);
  }
  /* Each reason says its own cause: only a blank parameter tells the person to fill in words. */
  expect(UNPRICED.skillPriceWords.hover).toMatch(/fill in its words/);
  expect(UNPRICED.skillPriceEngine.hover).toMatch(/engine/i);
  expect(UNPRICED.skillPriceEngine.hover).not.toMatch(/fill in its words/);
  expect(UNPRICED.skillPriceStep.hover).not.toMatch(/fill in its words/);
});

test("a short-lived read is kept per workspace scope: the same scope shares it for its window, another scope never reuses it", () => {
  const read = scopedFresh<string>(10_000);
  let asked = 0;
  const make = (label: string) => () => { asked++; return label; };
  expect(read("ws-a", 0, make("a1"))).toBe("a1");
  expect(read("ws-a", 5_000, make("a2"))).toBe("a1");
  expect(asked).toBe(1);
  /* A switch inside the window asks afresh and never gets workspace A's answer. */
  expect(read("ws-b", 6_000, make("b1"))).toBe("b1");
  expect(asked).toBe(2);
  /* Switching back does not bring A's old answer back either: only the latest scope is held. */
  expect(read("ws-a", 7_000, make("a3"))).toBe("a3");
  expect(read("ws-a", 17_001, make("a4"))).toBe("a4");
  expect(read("ws-a", 17_002, make("a5"))).toBe("a4");
});
