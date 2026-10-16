import { test, expect } from "@playwright/test";
import { newProjectBoard, newProjectRail } from "../../lib/v12/board/new-project";
import { FILM_STAGES, removeStage, stageEmpty, stagesOf } from "../../lib/v12/board/stages";
import { NEW_PROJECT, newProjectFor, EMPTY_DRAFT } from "../../components/graphite/home/home-model";
import { seededProject } from "../../lib/shell/create-project";
import { projectSchema } from "../../lib/workbench/studio-schema";

/**
 * "+ New project" on Home (demo plan PR 32 + D-1): a Film board whose rail begins with the demo's steps, made by PR 4's `startingRail`
 * (lib/v12/board/new-project.ts).
 */
test("the rail reads Pitch, Brief, Script, Cast, Storyboard, Shots, then Edit and Deliver; Elements is kept, skipped", () => {
  const stages = stagesOf("film", newProjectRail());
  expect(stages.filter((s) => !s.skipped).map((s) => s.label)).toEqual(["Pitch", "Brief", "Script", "Cast", "Storyboard", "Shots", "Edit", "Deliver"]);
  expect(stages.find((s) => s.id === "elements")!.skipped).toBe(true);
  expect(stages[0]).toMatchObject({ id: "pitch", custom: false, regions: [] });
});

test("no card is hidden: every built-in Film stage that holds cards is on the new project's rail", () => {
  const ids = new Set(stagesOf("film", newProjectRail()).map((s) => s.id));
  for (const def of FILM_STAGES.filter((d) => d.regions.length)) expect(ids.has(def.id), def.id).toBe(true);
});

test("a new project keeps the rail it was made with: Treatment and Locations are not added back on read", () => {
  expect(stagesOf("film", newProjectRail()).map((s) => s.id)).not.toContain("treatment");
  expect(stagesOf("film", newProjectRail()).map((s) => s.id)).not.toContain("locations");
});

test("Pitch has its own empty state", () => {
  expect(stageEmpty(stagesOf("film", newProjectRail())[0])).toEqual({ title: "Pitch", line: "The deck for the film, made from the board." });
});

test("a new project is a Film board with that rail, and the draft schema keeps it", () => {
  const { name, seed } = newProjectFor(NEW_PROJECT, EMPTY_DRAFT);
  expect(name).toBe("Untitled project");
  expect(seed).toMatchObject({ boardKind: "studio", boardFlavor: "film" });
  const project = seededProject(name, seed);
  expect(project.boardFlavor).toBe("film");
  expect(project.boardStages).toEqual(newProjectBoard().boardStages);
  expect(projectSchema.safeParse(project).success).toBe(true);
});

test("the rail is made by startingRail: kept steps are bare, Elements is skipped, Treatment and Locations are flagged removed", () => {
  const rail = newProjectRail();
  expect(rail.find((s) => s.id === "pitch")).toEqual({ id: "pitch" });
  expect(rail.find((s) => s.id === "elements")).toEqual({ id: "elements", skipped: true });
  expect(rail.find((s) => s.id === "treatment")).toEqual({ id: "treatment", removed: true });
  expect(rail.find((s) => s.id === "locations")).toEqual({ id: "locations", removed: true });
});

test("a person who removes Pitch keeps it removed on read, and Treatment and Locations are never added back", () => {
  const rail = newProjectRail();
  const edited = removeStage(stagesOf("film", rail), "pitch");
  const back = stagesOf("film", edited).map((s) => s.id);
  expect(back).not.toContain("pitch");
  expect(back).not.toContain("treatment");
  expect(back).not.toContain("locations");
  expect(back).toEqual(["brief", "script", "cast", "elements", "storyboard", "shots", "edit", "deliver"]);
  expect(projectSchema.safeParse(seededProject("x", { boardFlavor: "film", boardStages: edited })).success).toBe(true);
});

test("the rail is copied, never shared: editing one board's rail cannot change the next board's", () => {
  const a = newProjectRail(), b = newProjectRail();
  a[0].label = "Changed";
  expect(b[0].label).toBeUndefined();
  expect(newProjectRail()[0].label).toBeUndefined();
});
