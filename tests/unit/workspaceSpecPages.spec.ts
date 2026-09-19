import { test, expect } from "@playwright/test";
import { newProject } from "../../lib/workbench/studio";
import { ALL_PAGES, PAGES, libraryFor } from "../../lib/workspace/pages";
import {
  EMPTY_FACTS,
  SPEC_PAGES,
  cardChips,
  cardFooter,
  cardState,
  firstSentence,
  specCopy,
  type SpecFacts,
} from "../../lib/workspace/spec-cards";
import { vendorNameIn } from "../../lib/workspace/vendor-names";
import { vendorNameIn as productVendorNameIn } from "../../lib/vendorNames";
import type { PageId } from "../../lib/workspace/types";

/* 03-pages.md, "Card counts per page". */
const COUNTS: Record<string, number[]> = {
  brief: [4, 3], boards: [2, 3], astra: [4, 2], deliver: [2, 3],
  agent: [4, 2], runs: [4, 2], recipes: [4], builds: [4, 3], skills: [6], models: [2, 4], approvals: [4], budget: [4],
  marketing: [4, 3, 3, 4],
  motion: [4, 3], swap: [4], sources: [4], compare: [4], history: [4],
};

/* Names and figures from the prototype's fixture project; none may ship. */
const FIXTURES = [
  /\bDune\b/i, /\bMira\b/, /ZigZag/i, /\bAster\b/, /Nightline/i, /Second figure/, /mirrored/i, /chrome dusk/i, /desert daylight/i,
  /Warm sand/i, /\$\s?\d/, /\b12 pp\b/, /\b24 frames\b/, /\b6 scenes\b/, /\b9 refs\b/, /\b18 notes\b/, /\b3 swatches\b/,
  /\b3 versions\b/, /\bcap 4\b/, /\b5 slots\b/, /\b6 engines\b/, /0 of 6 shots/, /\b35mm\b/, /eye level/, /\b4 presets\b/,
];

/* A project with something in every field the cards count. */
const full: SpecFacts = {
  ...EMPTY_FACTS,
  project: {
    ...newProject("Harbour at dusk"),
    productionProjectId: "prod-1",
    brief: "A harbour film in three movements.",
    script: "INT. BOATHOUSE - NIGHT\n\nRain.\n\nEXT. QUAY - DAWN\n\nGulls.",
    shots: [{ id: "s1", name: "01 — Quay", assetId: "a1", duration: 48, sourceIn: 0, note: "Hold." }],
    assets: [{ id: "a1", name: "Quay plate", kind: "image", category: "Look", url: "/x.png", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], uploadId: "u1" }],
  },
  runs: [{ id: "r1", state: "awaiting_approval", pipelineId: "p1", pipelineVersion: 1, attempts: [{ state: "uncertain" }] }],
  budget: { credits: 1234, capCredits: 2500 },
  planPrice: "Quote at gate",
};

test("every spec page has its groups and cards, per 03", () => {
  expect(Object.keys(SPEC_PAGES).sort()).toEqual(Object.keys(COUNTS).sort());
  for (const [id, counts] of Object.entries(COUNTS)) {
    const spec = SPEC_PAGES[id as PageId]!;
    expect(spec.groups.map((g) => g.cards.length), id).toEqual(counts);
    expect(spec.intro.length, id).toBeGreaterThan(40);
    for (const group of spec.groups) {
      expect(group.title, id).toBe(group.title.toUpperCase());
      for (const card of group.cards) {
        expect(card.name.length, `${id}/${card.name}`).toBeGreaterThan(0);
        expect(card.desc.length, `${id}/${card.name}`).toBeGreaterThan(10);
        expect(card.owner.length, `${id}/${card.name}`).toBeGreaterThan(0);
        /* A card that opens a tool names one the page has. */
        if (card.tool) expect(spec.tools.map((t) => t.id), `${id}/${card.name}`).toContain(card.tool);
      }
    }
    expect(spec.facts(EMPTY_FACTS), id).toHaveLength(5);
    expect(spec.facts(full), id).toHaveLength(5);
  }
  /* Generate keeps its own body; it is not a spec page. */
  expect(SPEC_PAGES.generate).toBeUndefined();
});

test("no card copy names a vendor or a prototype fixture", () => {
  const problems: string[] = [];
  let checked = 0;
  for (const id of Object.keys(SPEC_PAGES) as PageId[])
    for (const facts of [EMPTY_FACTS, full])
      for (const text of specCopy(id, facts)) {
        checked += 1;
        const vendor = vendorNameIn(text) ?? productVendorNameIn(text);
        if (vendor) problems.push(`${id}: "${text}" names ${vendor}`);
        for (const fixture of FIXTURES) if (fixture.test(text)) problems.push(`${id}: "${text}" matches ${fixture}`);
      }
  expect(checked).toBeGreaterThan(500);
  expect(problems).toEqual([]);
});

test("with no data every card is READY; states come only from evidence", () => {
  for (const id of Object.keys(SPEC_PAGES) as PageId[])
    for (const card of SPEC_PAGES[id]!.groups.flatMap((g) => g.cards)) expect(cardState(card, EMPTY_FACTS), `${id}/${card.name}`).toBe("READY");
  const card = (page: PageId, name: string) => SPEC_PAGES[page]!.groups.flatMap((g) => g.cards).find((c) => c.name === name)!;
  expect(cardState(card("brief", "Brief"), full)).toBe("COMPLETE");
  expect(cardState(card("brief", "Script"), full)).toBe("COMPLETE");
  expect(cardState(card("brief", "Screenplay import"), full)).toBe("READY");
  expect(cardState(card("boards", "Frames"), full)).toBe("COMPLETE");
  expect(cardState(card("approvals", "Priced gate"), full)).toBe("WAITING");
  expect(cardState(card("runs", "Recovery records"), full)).toBe("ACTIVE");
  expect(cardState(card("budget", "Caps"), full)).toBe("ACTIVE");
  /* The page's plan drives the card it performs. */
  expect(cardState(card("brief", "Draft from brief"), { ...EMPTY_FACTS, planRun: { status: "running" } })).toBe("ACTIVE");
  expect(cardState(card("brief", "Draft from brief"), { ...EMPTY_FACTS, planRun: { status: "waiting" } })).toBe("WAITING");
  expect(cardState(card("brief", "Draft from brief"), { ...EMPTY_FACTS, planCompleted: true })).toBe("COMPLETE");
  expect(cardFooter(card("agent", "Autonomy"), "WAITING")).toBe("You · waiting on you");
  expect(cardFooter(card("boards", "Look board"), "COMPLETE")).toBe("Art director · complete");
});

test("counts come from the project and format with en-US grouping", () => {
  const card = (page: PageId, name: string) => SPEC_PAGES[page]!.groups.flatMap((g) => g.cards).find((c) => c.name === name)!;
  expect(cardChips(card("brief", "Script"), full)).toEqual(["2 scenes"]);
  expect(cardChips(card("boards", "Frames"), full)).toEqual(["1 frame"]);
  expect(cardChips(card("budget", "Caps"), full)).toEqual(["2,500 cr"]);
  expect(SPEC_PAGES.budget!.facts(full)[0]).toEqual(["Project spend", "1,234 cr"]);
  expect(SPEC_PAGES.brief!.facts(full)[1]).toEqual(["Scenes", "2"]);
});

test("home feature cards read the first sentence of the intro; Library derives from the groups", () => {
  for (const id of Object.keys(SPEC_PAGES) as PageId[]) {
    const def = ALL_PAGES.find((p) => p.id === id)!;
    expect(def.description, id).toBe(firstSentence(SPEC_PAGES[id]!.intro));
    expect(libraryFor(id).map((g) => g.items.length), id).toEqual(SPEC_PAGES[id]!.groups.map((g) => g.cards.length));
  }
  expect(firstSentence("Describe the outcome; the agent plans it. It reaches every suite.")).toBe("Describe the outcome; the agent plans it.");
  expect(PAGES.particl.find((p) => p.id === "astra")!.title).toBe("Astra 3D");
});
