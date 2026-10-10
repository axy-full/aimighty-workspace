import { test, expect } from "@playwright/test";
import { shellPage } from "../../lib/shell/ia";
import { isStageId, stageAddress } from "../../lib/shell/stage-redirects";
import { FIRST_RUN_STEPS, recentProjects, savedAt } from "../../lib/shell/studio-home";

/** Studio's first run and Home's recent projects (lib/shell/studio-home.ts): pure. */
test("the four steps are Brief → Beats → Boards → Takes, each opening the board's region for that stage", () => {
  expect(FIRST_RUN_STEPS.map((s) => s.label)).toEqual(["Brief", "Beats", "Boards", "Takes"]);
  for (const step of FIRST_RUN_STEPS) {
    expect(isStageId(step.id), step.id).toBe(true);
    expect(stageAddress(step.id)).toMatch(/^\?view=board/);
    /* The stage pages are deleted: nothing is a page any more. */
    expect(shellPage("studio", step.id), step.id).toBeNull();
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
