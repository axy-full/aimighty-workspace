import { test, expect } from "@playwright/test";
import { PAGES as LEGACY_PAGES, SUITES as LEGACY_SUITES } from "../../lib/suites";
import {
  ALL_PAGES, LIBRARY, PAGES, PAGE_ALIASES, SUITES, crumbFor, libraryCount, libraryFor, pageKind,
  pageViews, primaryAction, resolvePageId, resolveSuite, subtitle, suiteOfPage,
} from "../../lib/workspace/pages";
import { nextSentence } from "../../lib/workspace/next";
import { INITIAL_STATE } from "../../lib/workspace/navigation";

test("suites reuse lib/suites names and identity dots, in order", () => {
  expect(SUITES.map((s) => s.id)).toEqual(LEGACY_SUITES.map((s) => s.id));
  for (const suite of SUITES) {
    const legacy = LEGACY_SUITES.find((s) => s.id === suite.id)!;
    expect(suite.name).toBe(legacy.name);
    expect(suite.dot).toBe(legacy.color);
  }
  expect(SUITES.map((s) => s.short)).toEqual(["Studio", "Agent", "Business", "Viral"]);
  expect(SUITES[0].desc).toBe("The production studio. Eight stages from brief to delivery.");
});

test("page ids per suite match the architecture contract; Atomik keeps Generate", () => {
  expect(PAGES.particl.map((p) => p.id)).toEqual(["brief", "boards", "cast", "astra", "rig", "takes", "edit", "deliver"]);
  expect(PAGES.atomik.map((p) => p.id)).toEqual(["agent", "runs", "generate", "recipes", "builds", "skills", "models", "approvals", "budget"]);
  expect(PAGES.moleculr.map((p) => p.id)).toEqual(["marketing"]);
  expect(PAGES.subatomik.map((p) => p.id)).toEqual(["motion", "swap", "sources", "compare", "history"]);
  expect(new Set(ALL_PAGES.map((p) => p.id)).size).toBe(ALL_PAGES.length);
  for (const p of ALL_PAGES) expect(p.description.length).toBeGreaterThan(0);
});

test("stage tabs are short, titles are full", () => {
  const byId = Object.fromEntries(ALL_PAGES.map((p) => [p.id, p]));
  expect([byId.brief.label, byId.brief.title]).toEqual(["Brief", "Brief & Script"]);
  expect([byId.cast.label, byId.cast.title]).toEqual(["Cast", "Cast & Elements"]);
  expect([byId.astra.label, byId.astra.title]).toEqual(["Astra", "Astra blender"]);
  expect([byId.edit.label, byId.edit.title]).toEqual(["Edit", "Edit & Sound"]);
});

test("every current and retired page id resolves", () => {
  expect(PAGE_ALIASES).toMatchObject({
    storyboard: "boards", characters: "cast", "astra-blender": "astra", canvas: "rig",
    assets: "takes", export: "deliver", "motion-transfer": "motion", "object-swap": "swap",
  });
  /* Retired stage ids chain through lib/suites.ts aliases. */
  expect(resolvePageId("script")).toBe("brief");
  expect(resolvePageId("moodboard")).toBe("boards");
  expect(resolvePageId("elements")).toBe("cast");
  expect(resolvePageId("nope")).toBeNull();
  expect(resolveSuite("subatomic")).toBe("subatomik");
  /* Every page the existing suites expose still opens something. */
  for (const suite of Object.keys(LEGACY_PAGES) as (keyof typeof LEGACY_PAGES)[])
    for (const page of LEGACY_PAGES[suite]) {
      const resolved = resolvePageId(page.id);
      expect(resolved, page.id).not.toBeNull();
      expect(suiteOfPage(resolved!)).toBe(suite);
    }
});

test("primary action, views and selection kind per page", () => {
  expect(primaryAction("rig")).toEqual({ kind: "generate", label: "Generate", key: "G" });
  expect(primaryAction("takes").label).toBe("+ Upload");
  expect(primaryAction("cast").label).toBe("+ Add cast");
  for (const id of ["brief", "agent", "marketing", "history"] as const) expect(primaryAction(id)).toEqual({ kind: "run-stage", label: "+ Run stage", key: "A" });
  expect(pageViews("rig").map((v) => v.label)).toEqual(["List", "Canvas"]);
  expect(pageViews("takes").map((v) => v.id)).toEqual(["All", "Uploads", "Generations"]);
  expect(pageViews("brief")).toEqual([]);
  expect([pageKind("rig"), pageKind("takes"), pageKind("cast"), pageKind("brief")]).toEqual(["shot", "take", "cast", "page"]);
  expect(crumbFor({ page: "rig", suite: "particl", rigView: "graph" })).toEqual({ crumb: "Main composition", kicker: "NODE GRAPH" });
  expect(crumbFor({ page: "brief", suite: "particl", rigView: "list" })).toEqual({ crumb: "Brief & Script", kicker: "STUDIO" });
});

test("library: Rig matches the reference; other pages derive from spec groups", () => {
  const rig = libraryFor("rig");
  expect(rig.map((g) => [g.title, g.items.length])).toEqual([["REFERENCES", 5], ["CREATE", 2], ["FINISH", 4], ["FLOW", 4]]);
  expect(libraryCount(rig)).toBe(15);
  expect(Object.keys(LIBRARY).sort()).toEqual(["cast", "edit", "rig", "takes"]);
  expect(libraryFor("brief")).toEqual([]);
  expect(libraryFor("brief", { brief: [{ title: "DOCUMENT", cards: [{ name: "Script", chips: ["v3", "6 scenes"] }] }] }))
    .toEqual([{ title: "DOCUMENT", items: [{ name: "Script", sub: "v3 · 6 scenes" }] }]);
});

test("subtitles derive from loaded data and say nothing before it loads", () => {
  const lists = { shots: null, takes: null, cast: null };
  expect(subtitle({ page: "rig", lists })).toBe("");
  expect(subtitle({ page: "rig", lists: { ...lists, shots: [{ id: "a", name: "A", status: "approved" }, { id: "b", name: "B", status: "draft" }] } })).toBe("2 shots · 1 approved");
  expect(subtitle({ page: "takes", lists: { ...lists, takes: Array.from({ length: 1200 }, (_, i) => ({ id: String(i), name: "t" })) } })).toBe("1,200 assets");
  expect(subtitle({ page: "cast", lists: { ...lists, cast: [{ id: "a", name: "A", group: "cast" }, { id: "b", name: "B", group: "elements" }] } })).toBe("1 cast · 1 element");
  expect(subtitle({ page: "deliver", lists }, { aspect: "16:9", fps: 24 })).toBe("16:9 · 24 fps");
});

test("NEXT line: waiting → running → rendering → ready shots → plan title → nothing", () => {
  const base = { ...INITIAL_STATE, page: "rig" as const };
  const plan = { title: "Render every ready shot", price: "Quote at gate", gatePrice: "36 cr", steps: ["Resolve references", "Quote the shots"] };
  expect(nextSentence({ ...base, run: { page: "rig", i: 1, status: "waiting", approved: false } }, plan)).toBe("Waiting on your approval — 36 cr.");
  expect(nextSentence({ ...base, run: { page: "rig", i: 1, status: "running", approved: false } }, plan)).toBe("Quote the shots…");
  expect(nextSentence({ ...base, gen: { id: "g", pct: 40, name: "The encounter", meta: "" } }, plan)).toBe("Rendering The encounter. Nothing else is blocked.");
  const shots = [{ id: "a", name: "Wide", status: "draft" }, { id: "b", name: "Close", status: "ready" }];
  expect(nextSentence({ ...base, lists: { ...base.lists, shots } }, plan)).toBe("1 shot is ready to render. Start with Close.");
  expect(nextSentence(base, plan)).toBe("Render every ready shot — quote at gate.");
  expect(nextSentence(base, null)).toBe("Nothing waiting on this page.");
  /* A run on another page does not speak for this one. */
  expect(nextSentence({ ...base, run: { page: "boards", i: 0, status: "waiting", approved: false } }, null)).toBe("Nothing waiting on this page.");
});
