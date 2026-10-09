import { test, expect } from "@playwright/test";
import { FILM_STAGES, KIND_LABEL, addStage, currentStage, moveStage, removeStage, renameStage, selectionCrumb, skipStage, stageCards, stageEmpty, stagePrimary, stagesOf, stageStatus } from "../../lib/v12/board/stages";
import { STUDIO_RAIL } from "../../lib/board/regions";
import type { BoardCard } from "../../lib/board/types";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";

/**
 * A board's stages in the new interface (lib/v12/board/stages.ts; inventory § 6.1–§ 6.4): the Film rail over today's
 * Studio regions, the slice of today's cards each stage draws, rail edits kept in the draft, and the one primary.
 */
const card = (id: string, region: BoardCard["region"], extra: Partial<BoardCard> = {}): BoardCard => ({ id, kind: "take", region, order: 0, state: "done", data: {}, ...extra });
const CARDS: BoardCard[] = [
  card("doc:brief", "brief", { kind: "doc" }),
  card("look:1", "looks", { kind: "look" }),
  card("group:cast", "cast", { kind: "group", state: "needs" }),
  card("cast:a", "cast", { kind: "cast", state: "needs", data: { variant: "cast" } }),
  card("cast:b", "cast", { kind: "cast", data: { variant: "environment" } }),
  card("cast:c", "cast", { kind: "cast", state: "empty", data: { variant: "element" } }),
  card("frame:1", "storyboard", { kind: "frame", state: "working" }),
  card("plan:run", "storyboard", { kind: "plan", state: "needs" }),
  card("shot:1", "shots"),
  card("made:1", "made", { kind: "made" }),
  card("note:1", null, { kind: "note", at: { x: 0, y: 0 } }),
];

test("a Studio board is a Film board: Brief · Script · Cast · Elements · Storyboard · Shots · Cut · Deliver, opening on Storyboard", () => {
  const stages = stagesOf("studio", STUDIO_RAIL, null);
  expect(stages.map((s) => s.label)).toEqual(["Brief", "Script", "Cast", "Elements", "Storyboard", "Shots", "Cut", "Deliver"]);
  expect(KIND_LABEL.studio).toBe("Film");
  expect(currentStage(stages, null, "studio")!.id).toBe("storyboard");
  expect(currentStage(stages, "cast", "studio")!.id).toBe("cast");
  expect(currentStage(stages, "nonsense", "studio")!.id).toBe("storyboard");
  /* Another kind keeps its own rail, one stage per region. */
  const ads = stagesOf("ads", [{ id: "brand", label: "Brand", icon: "" }, { id: "formats", label: "Formats", icon: "" }], null);
  expect(ads.map((s) => s.id)).toEqual(["brand", "formats"]);
  expect(currentStage(ads, null, "ads")!.id).toBe("brand");
});

test("each stage draws a slice of today's cards: Cast the people, Elements the places and things, Shots the made band", () => {
  const ids = (id: string) => stageCards(FILM_STAGES.find((s) => s.id === id)!, CARDS, "studio", STUDIO_RAIL).map((c) => c.id);
  expect(ids("brief")).toEqual(["doc:brief", "look:1"]);
  expect(ids("script")).toEqual([]);
  expect(ids("cast")).toEqual(["group:cast", "cast:a"]);
  expect(ids("elements")).toEqual(["group:cast", "cast:b", "cast:c"]);
  expect(ids("storyboard")).toEqual(["frame:1", "plan:run"]);
  expect(ids("shots")).toEqual(["shot:1", "made:1"]);
  /* A free card belongs to no stage. */
  for (const s of FILM_STAGES) expect(ids(s.id)).not.toContain("note:1");
  /* Markers: Cast needs a person (its card, not its group frame), Elements has nothing waiting. */
  expect(stageStatus(FILM_STAGES[2], CARDS, "studio", STUDIO_RAIL).state).toBe("needs");
  expect(stageStatus(FILM_STAGES[3], CARDS, "studio", STUDIO_RAIL).state).not.toBe("needs");
});

test("rail edits are the whole saved list: rename, skip, remove, move, add; unknown or duplicate ids are dropped on read", () => {
  const stages = stagesOf("studio", STUDIO_RAIL, null);
  const renamed = renameStage(stages, "cut", "  Edit  ");
  expect(renamed.find((s) => s.id === "cut")).toEqual({ id: "cut", label: "Edit" });
  expect(renamed.find((s) => s.id === "brief")).toEqual({ id: "brief" });
  expect(renameStage(stages, "cut", "   ").find((s) => s.id === "cut")).toEqual({ id: "cut" });
  const skipped = stagesOf("studio", STUDIO_RAIL, skipStage(stages, "script", true));
  expect(skipped.find((s) => s.id === "script")!.skipped).toBe(true);
  expect(stagesOf("studio", STUDIO_RAIL, removeStage(stages, "script")).map((s) => s.id)).not.toContain("script");
  expect(stagesOf("studio", STUDIO_RAIL, moveStage(stages, "deliver", 0))[0].id).toBe("deliver");
  const added = addStage(stages, "storyboard", "Animatic", () => "abc");
  const after = stagesOf("studio", STUDIO_RAIL, added.saved);
  expect(after.map((s) => s.id).slice(4, 6)).toEqual(["storyboard", "custom-abc"]);
  expect(after[5]).toMatchObject({ label: "Animatic", custom: true });
  expect(stagesOf("studio", STUDIO_RAIL, [{ id: "brief" }, { id: "brief" }, { id: "gone" }, { id: "custom-x", custom: true }]).map((s) => s.id)).toEqual(["brief", "custom-x"]);
});

test("the rail's arrangement is part of the draft JSON: the project schema takes it and refuses nonsense", () => {
  const project = { ...newProject("Board"), boardStages: renameStage(stagesOf("studio", STUDIO_RAIL, null), "cut", "Edit") };
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "bad id!" }] }).success).toBe(false);
  expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "brief", colour: "red" }] }).success).toBe(false);
});

test("one primary, only where its action lives; it never spends", () => {
  const stage = (id: string) => ({ id });
  expect(stagePrimary(stage("cast"), CARDS, "studio")).toEqual({ label: "Review the cast", card: "cast:a" });
  expect(stagePrimary(stage("storyboard"), CARDS, "studio")).toEqual({ label: "Review the plan", card: "plan:run" });
  expect(stagePrimary(stage("shots"), CARDS, "studio")).toEqual({ label: "Review the plan", card: "plan:run" });
  for (const id of ["brief", "script", "elements", "cut", "deliver"]) expect(stagePrimary(stage(id), CARDS, "studio")).toBeNull();
  expect(stagePrimary(stage("cast"), CARDS.filter((c) => c.id !== "cast:a"), "studio")).toBeNull();
  expect(stagePrimary(stage("cast"), CARDS, "ads")).toBeNull();
});

test("the empty stage and the selection crumb", () => {
  expect(stageEmpty({ id: "cut", label: "Cut", custom: false }).title).toBe("Nothing to cut yet");
  expect(stageEmpty({ id: "custom-1", label: "Animatic", custom: true }).title).toBe("Animatic");
  expect(stageEmpty({ id: "custom-2", label: "Grading", custom: true })).toEqual({ title: "Grading", line: "A stage you added. Drop cards here from the Library, or ask for it in the bar.", ask: true });
  expect(selectionCrumb([])).toBeNull();
  expect(selectionCrumb(["Shot 4"])).toBe("Shot 4");
  expect(selectionCrumb(["a", "b", "c"])).toBe("3 cards");
});
