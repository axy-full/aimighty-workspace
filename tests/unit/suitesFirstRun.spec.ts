import { test, expect } from "@playwright/test";
import { newProject } from "../../lib/workbench/studio";
import { shellPage } from "../../lib/shell/ia";
import { FIRST_RUN_STEPS, recentProjects, runningTakes, savedAt, stageCards, startsEmpty } from "../../lib/shell/studio-home";
import type { LibraryEntry } from "../../lib/workspace/library";

/** Studio's first run and the Studio home's lists (lib/shell/studio-home.ts): pure, from the project and the library. */
const take = (id: string, status: string, kind: "GEN" | "UPLOAD" = "GEN") =>
  ({ take: { id, sourceId: id, kind, name: id, version: "v1", meta: "", credits: null, usd: null, status, sha256: null, createdAt: 0 }, asset: {} as never, url: null, media: null }) as unknown as LibraryEntry;

test("the four steps are Brief → Beats → Boards → Takes, each a real Studio stage", () => {
  expect(FIRST_RUN_STEPS.map((s) => s.label)).toEqual(["Brief", "Beats", "Boards", "Takes"]);
  for (const step of FIRST_RUN_STEPS) {
    const page = shellPage("studio", step.id);
    expect(page, step.id).toBeTruthy();
    expect(page!.phoneOnly).toBeFalsy();
  }
});

test("recent projects: most recently saved first, never the open one, at most the limit; any saved time the route sends", () => {
  const list = [
    { id: "a", name: "Old", updatedAt: "1000" },
    { id: "b", name: "Newest", updatedAt: 3000 as unknown as string },
    { id: "c", name: "Iso", updatedAt: "2026-09-18T10:00:00Z" },
    { id: "d", name: "Never saved" },
  ];
  expect(recentProjects(list, null).map((p) => p.id)).toEqual(["c", "b", "a", "d"]);
  expect(recentProjects(list, "c", 2).map((p) => p.id)).toEqual(["b", "a"]);
  expect(recentProjects([], null)).toEqual([]);
  expect(savedAt({ updatedAt: "2026-09-18T10:00:00Z" })).toBe(Date.parse("2026-09-18T10:00:00Z"));
  expect(savedAt({ updatedAt: 42 as unknown as string })).toBe(42);
  expect(savedAt({ updatedAt: "" })).toBeNull();
  expect(savedAt({ updatedAt: "not a date" })).toBeNull();
  expect(savedAt({})).toBeNull();
});

test("Running lists only the project's generated takes still in flight", () => {
  expect(runningTakes([take("a", "rendering"), take("b", "review"), take("c", "rendering", "UPLOAD"), take("d", "failed")]).map((e) => e.take.id)).toEqual(["a"]);
});

test("a project with nothing in it yet starts at the brief", () => {
  expect(startsEmpty(null)).toBe(false);
  expect(startsEmpty(newProject("Harbour"))).toBe(true);
  expect(startsEmpty({ ...newProject("Harbour"), brief: "A fox at dusk" })).toBe(false);
  expect(startsEmpty({ ...newProject("Harbour"), shots: [{ id: "s1", name: "One", assetId: "", duration: 5, sourceIn: 0, note: "" }] })).toBe(false);
});

test("the Cast card counts the stage's own entries as well as pictured cast", () => {
  const project = { ...newProject("Starter"), production: { cast: { entries: [
    { id: "cast-01", name: "Courier", kind: "character" as const, description: "", prompt: "", takes: [] },
    { id: "cast-02", name: "Mule", kind: "element" as const, description: "", prompt: "", takes: [] },
  ] } } };
  expect(stageCards(project, []).find((c) => c.id === "cast")).toMatchObject({ meta: "1 identity · 1 element", status: "done" });
});
