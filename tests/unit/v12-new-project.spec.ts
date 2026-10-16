import { test, expect } from "@playwright/test";
import { NEW_PROJECT_STEPS, newProjectBoard } from "../../lib/v12/board/new-project";
import { FILM_STAGES, stageEmpty, stagesOf } from "../../lib/v12/board/stages";
import { NEW_PROJECT, newProjectFor, EMPTY_DRAFT } from "../../components/graphite/home/home-model";
import { seededProject } from "../../lib/shell/create-project";
import { projectSchema } from "../../lib/workbench/studio-schema";

/**
 * "+ New project" on Home (demo plan PR 32 + D-1): a Film board whose rail begins with the demo's steps. The list is in one
 * place (lib/v12/board/new-project.ts) for PR 4 to own.
 */
test("the rail reads Pitch, Brief, Script, Cast, Storyboard, Shots, then Edit and Deliver; Elements is kept, skipped", () => {
  const stages = stagesOf("film", NEW_PROJECT_STEPS);
  expect(stages.filter((s) => !s.skipped).map((s) => s.label)).toEqual(["Pitch", "Brief", "Script", "Cast", "Storyboard", "Shots", "Edit", "Deliver"]);
  expect(stages.find((s) => s.id === "elements")!.skipped).toBe(true);
  expect(stages[0]).toMatchObject({ id: "pitch", custom: false, regions: [] });
});

test("no card is hidden: every built-in Film stage that holds cards is on the new project's rail", () => {
  const ids = new Set(stagesOf("film", NEW_PROJECT_STEPS).map((s) => s.id));
  for (const def of FILM_STAGES.filter((d) => d.regions.length)) expect(ids.has(def.id), def.id).toBe(true);
});

test("a new project keeps the rail it was made with: Treatment and Locations are not added back on read", () => {
  expect(stagesOf("film", NEW_PROJECT_STEPS).map((s) => s.id)).not.toContain("treatment");
  expect(stagesOf("film", NEW_PROJECT_STEPS).map((s) => s.id)).not.toContain("locations");
});

test("Pitch has its own empty state", () => {
  expect(stageEmpty(stagesOf("film", NEW_PROJECT_STEPS)[0])).toEqual({ title: "Pitch", line: "The deck for the film, made from the board." });
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

test("the list is copied, never shared: editing one board's rail cannot change the next board's", () => {
  const a = newProjectBoard().boardStages, b = newProjectBoard().boardStages;
  a[0].label = "Changed";
  expect(b[0].label).toBeUndefined();
  expect(NEW_PROJECT_STEPS[0].label).toBeUndefined();
});
