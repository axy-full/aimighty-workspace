import { test, expect } from "@playwright/test";
import { MAX_STAGES, stageLimit, CAMPAIGN_STAGES, CLIPS_STAGES, FILM_STAGES, KIND_LABEL, NARRATED_STAGES, OPENS_ON, PREVIS_STAGES, addStage, applyStageEdit, currentStage, moveStage, removeStage, renameStage, selectionCrumb, skipStage, stageCards, stageEmpty, stagePrimary, stagesOf, stageStatus } from "../../lib/v12/board/stages";
import type { BoardCard } from "../../lib/board/types";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";
import { COMPOSER, DEFAULT_FLAVOR, FLAVORS, FLAVOR_BOARD, KIND_CARDS, boardName, detectCard, flavorForCard, flavorOf, nextFlavor } from "../../lib/v12/board/kinds";
import { seededProject } from "../../lib/shell/create-project";

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
  const stages = stagesOf("film", null);
  expect(stages.map((s) => s.label)).toEqual(["Brief", "Script", "Cast", "Elements", "Storyboard", "Shots", "Cut", "Deliver"]);
  expect(KIND_LABEL.film).toBe("Film");
  expect(currentStage(stages, null, "film")!.id).toBe("storyboard");
  expect(currentStage(stages, "cast", "film")!.id).toBe("cast");
  expect(currentStage(stages, "nonsense", "film")!.id).toBe("storyboard");
});

test("each stage draws a slice of today's cards: Cast the people, Elements the places and things, Shots the made band", () => {
  const ids = (id: string) => stageCards(FILM_STAGES.find((s) => s.id === id)!, CARDS, "film").map((c) => c.id);
  expect(ids("brief")).toEqual(["doc:brief", "look:1"]);
  expect(ids("script")).toEqual([]);
  expect(ids("cast")).toEqual(["group:cast", "cast:a"]);
  expect(ids("elements")).toEqual(["group:cast", "cast:b", "cast:c"]);
  expect(ids("storyboard")).toEqual(["frame:1", "plan:run"]);
  expect(ids("shots")).toEqual(["shot:1", "made:1"]);
  /* A free card belongs to no stage. */
  for (const s of FILM_STAGES) expect(ids(s.id)).not.toContain("note:1");
  /* Markers: Cast needs a person (its card, not its group frame), Elements has nothing waiting. */
  expect(stageStatus(FILM_STAGES[2], CARDS, "film").state).toBe("needs");
  expect(stageStatus(FILM_STAGES[3], CARDS, "film").state).not.toBe("needs");
});

test("rail edits are the whole saved list: rename, skip, remove, move, add; unknown or duplicate ids are dropped on read", () => {
  const stages = stagesOf("film", null);
  const renamed = renameStage(stages, "cut", "  Edit  ");
  expect(renamed.find((s) => s.id === "cut")).toEqual({ id: "cut", label: "Edit" });
  expect(renamed.find((s) => s.id === "brief")).toEqual({ id: "brief" });
  expect(renameStage(stages, "cut", "   ").find((s) => s.id === "cut")).toEqual({ id: "cut" });
  const skipped = stagesOf("film", skipStage(stages, "script", true));
  expect(skipped.find((s) => s.id === "script")!.skipped).toBe(true);
  expect(stagesOf("film", removeStage(stages, "script")).map((s) => s.id)).not.toContain("script");
  expect(stagesOf("film", moveStage(stages, "deliver", 0))[0].id).toBe("deliver");
  const added = addStage(stages, "storyboard", "Animatic", () => "abc");
  const after = stagesOf("film", added.saved);
  expect(after.map((s) => s.id).slice(4, 6)).toEqual(["storyboard", "custom-abc"]);
  expect(after[5]).toMatchObject({ label: "Animatic", custom: true });
  expect(stagesOf("film", [{ id: "brief" }, { id: "brief" }, { id: "gone" }, { id: "custom-x", custom: true }]).map((s) => s.id)).toEqual(["brief", "custom-x"]);
});

test("the rail's arrangement is part of the draft JSON: the project schema takes it and refuses nonsense", () => {
  const project = { ...newProject("Board"), boardStages: renameStage(stagesOf("film", null), "cut", "Edit") };
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "bad id!" }] }).success).toBe(false);
  expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "brief", colour: "red" }] }).success).toBe(false);
});

test("one primary, only on the stage that owns its action; it never spends", () => {
  const stage = (id: string) => ({ id });
  /* The plan sits in the Storyboard group while frames are drawn: Storyboard owns it, Shots does not. */
  expect(stagePrimary(stage("cast"), CARDS, "film")).toEqual({ label: "Review the cast", card: "cast:a" });
  expect(stagePrimary(stage("storyboard"), CARDS, "film")).toEqual({ label: "Review the plan", card: "plan:run" });
  expect(stagePrimary(stage("shots"), CARDS, "film")).toBeNull();
  /* Once the shots have taken the group's place, the plan stands in Shots: now Shots owns it, Storyboard does not. */
  const shotsPlan = CARDS.map((c) => (c.id === "plan:run" ? { ...c, region: "shots" as const } : c));
  expect(stagePrimary(stage("shots"), shotsPlan, "film")).toEqual({ label: "Review the plan", card: "plan:run" });
  expect(stagePrimary(stage("storyboard"), shotsPlan, "film")).toBeNull();
  /* Never more than one stage carries a primary for the plan, and no other stage has one. */
  for (const cards of [CARDS, shotsPlan]) expect(FILM_STAGES.filter((s) => s.id !== "cast" && stagePrimary(s, cards, "film")).length).toBe(1);
  for (const id of ["brief", "script", "elements", "cut", "deliver"]) expect(stagePrimary(stage(id), CARDS, "film")).toBeNull();
  expect(stagePrimary(stage("cast"), CARDS.filter((c) => c.id !== "cast:a"), "film")).toBeNull();
  expect(stagePrimary(stage("cast"), CARDS, "campaign")).toBeNull();
});

test("a board's rail holds at most as many stages as the draft's schema takes; the next one is refused, never saved", () => {
  expect(MAX_STAGES).toBe(24);
  expect(stageLimit(23)).toBeNull();
  expect(stageLimit(24)).toBe("A board holds up to 24 stages. Remove one to add another.");
  let saved = stagesOf("film", null);
  for (let i = 0; i < 16; i++) saved = stagesOf("film", addStage(saved, null, `Extra ${i}`, () => `x${i}`).saved);
  expect(saved).toHaveLength(24);
  const refused = addStage(saved, "brief", "One too many", () => "over");
  expect(refused.id).toBeNull();
  expect(refused.saved).toHaveLength(24);
  expect(applyStageEdit(saved, { type: "add", after: null, label: "Over" }, () => "z")).toMatchObject({ go: null });
  /* The full list is what the schema takes; one more is what it refuses (so adding it would have lost the whole draft). */
  const project = { ...newProject("Board"), boardStages: refused.saved };
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(projectSchema.safeParse({ ...project, boardStages: [...refused.saved, { id: "custom-extra", label: "More", custom: true }] }).success).toBe(false);
});

test("the empty stage and the selection crumb", () => {
  expect(stageEmpty({ id: "cut", label: "Cut", custom: false }).title).toBe("Nothing to cut yet");
  expect(stageEmpty({ id: "custom-1", label: "Animatic", custom: true }).title).toBe("Animatic");
  expect(stageEmpty({ id: "custom-2", label: "Grading", custom: true })).toEqual({ title: "Grading", line: "A stage you added. Drop cards here from the Library, or ask for it in the bar.", ask: true });
  expect(selectionCrumb([])).toBeNull();
  expect(selectionCrumb(["Shot 4"])).toBe("Shot 4");
  expect(selectionCrumb(["a", "b", "c"])).toBe("3 cards");
});

/* ── Kinds (lib/v12/board/kinds.ts) ─────────────────────────────────────────────────────────────── */

test("the five kinds and their rails, in the prototype's words, each opening where the prototype opens", () => {
  const labels = (flavor: (typeof FLAVORS)[number]) => stagesOf(flavor, null).map((s) => s.label);
  expect(labels("film")).toEqual(["Brief", "Script", "Cast", "Elements", "Storyboard", "Shots", "Cut", "Deliver"]);
  expect(labels("previs")).toEqual(["Brief", "Script", "Cast", "Elements", "Storyboard", "Animatic", "PPM deck"]);
  expect(labels("campaign")).toEqual(["Product", "Look", "Formats", "Variants", "Deliver"]);
  expect(labels("narrated")).toEqual(["Hook", "Script", "Scenes", "Voice", "Captions", "Deliver"]);
  expect(labels("clips")).toEqual(["Source", "Moments", "Clips", "Captions", "Deliver"]);
  expect(KIND_LABEL).toEqual({ film: "Film", previs: "Pre-vis", campaign: "Campaign", narrated: "Social · narrated", clips: "Social · clips" });
  for (const flavor of FLAVORS) {
    const stages = stagesOf(flavor, null);
    expect(currentStage(stages, null, flavor)!.id).toBe(OPENS_ON[flavor]);
    expect(currentStage(stages, "nonsense", flavor)!.id).toBe(OPENS_ON[flavor]);
  }
});

test("every region of a board belongs to some stage of every kind over it, so no card is hidden", () => {
  const regions = {
    studio: ["brief", "looks", "storyboard", "shots", "cast", "cut", "deliver", "next", "made"],
    ads: ["brand", "product", "hooks", "formats", "ads", "adapt", "deliver", "next", "made"],
    social: ["source", "clips", "hooks", "effects", "posts", "next", "made"],
  } as const;
  const rails = { film: FILM_STAGES, previs: PREVIS_STAGES, campaign: CAMPAIGN_STAGES, narrated: NARRATED_STAGES, clips: CLIPS_STAGES };
  for (const flavor of FLAVORS) {
    const held = new Set(rails[flavor].flatMap((s) => s.regions));
    for (const region of regions[FLAVOR_BOARD[flavor]]) expect(held.has(region as never), `${flavor}: ${region}`).toBe(true);
  }
});

test("a kind sits over today's board kind; a draft's own kind counts only over the data it fits", () => {
  expect(DEFAULT_FLAVOR).toEqual({ studio: "film", ads: "campaign", social: "clips" });
  expect(flavorOf("studio", "previs")).toBe("previs");
  expect(flavorOf("social", "narrated")).toBe("narrated");
  expect(flavorOf("ads", "previs")).toBe("campaign");
  expect(flavorOf("studio", undefined)).toBe("film");
  expect(flavorOf("studio", "nonsense")).toBe("film");
  expect(FLAVORS.map(nextFlavor)).toEqual(["previs", "campaign", "narrated", "clips", "film"]);
  /* The kind is part of the draft JSON: the schema takes the five and refuses anything else. */
  const project = { ...newProject("Board"), boardFlavor: "previs" as const };
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(projectSchema.safeParse({ ...project, boardFlavor: "documentary" }).success).toBe(false);
});

test("Pre-vis keeps Film's cards up to the storyboard; the animatic is the timed shots and cut, the PPM deck the delivery", () => {
  const ids = (id: string) => stageCards(PREVIS_STAGES.find((s) => s.id === id)!, CARDS, "previs").map((c) => c.id);
  expect(ids("storyboard")).toEqual(["frame:1", "plan:run"]);
  expect(ids("animatic")).toEqual(["shot:1", "made:1"]);
  expect(stagePrimary({ id: "storyboard" }, CARDS, "previs")).toEqual({ label: "Review the plan", card: "plan:run" });
  expect(stagePrimary({ id: "cast" }, CARDS, "previs")).toEqual({ label: "Review the cast", card: "cast:a" });
  expect(stagePrimary({ id: "ppm-deck" }, CARDS, "previs")).toBeNull();
});

test("the new-board words: four cards, the composer by kind, the kind the words suggest, the board's name", () => {
  expect(KIND_CARDS.map((k) => k.name)).toEqual(["Film", "Pre-vis", "Campaign", "Social"]);
  expect(COMPOSER.none.title).toBe("What are we making?");
  expect([COMPOSER.film.title, COMPOSER.previs.title, COMPOSER.campaign.title, COMPOSER.social.title]).toEqual(["Describe the film", "Paste or attach the agency script", "Paste the product page link", "A topic, or a long video link"]);
  expect(COMPOSER.film.chips.map((c) => c.id)).toEqual(["length", "aspect"]);
  expect(COMPOSER.social.chips.map((c) => c.id)).toEqual(["platform", "length"]);
  expect(detectCard("Ads for our new product page https://shop.example.com/tea")).toBe("campaign");
  expect(detectCard("A topic: why the tide turns")).toBe("social");
  expect(detectCard("The agency sent a script for the shoot")).toBe("previs");
  expect(detectCard("A harbour wakes up")).toBe("film");
  expect(flavorForCard("social", "A topic about tides")).toBe("narrated");
  expect(flavorForCard("social", "https://example.com/talk")).toBe("clips");
  expect(flavorForCard("social", "A video topic")).toBe("narrated");
  expect(flavorForCard("previs", "anything")).toBe("previs");
  expect(boardName("a harbour wakes up before the gulls do.", "film")).toBe("A harbour wakes up · film");
  expect(boardName("https://example.com/x", "campaign")).toBe("New board · campaign");
  expect(boardName("Why tides turn", "clips")).toBe("Why tides turn · social");
});

test("the rail edited before Start is the same list the board keeps; the project is seeded with the kind and the rail", () => {
  const stages = stagesOf("campaign", null);
  const { saved, go } = applyStageEdit(stages, { type: "rename", id: "look", label: "Brand look" }, () => "x");
  expect(go).toBeNull();
  expect(applyStageEdit(stages, { type: "add", after: "formats", label: "Recce" }, () => "x").go).toBe("custom-x");
  const project = seededProject("A board", { boardKind: "ads", boardFlavor: "campaign", boardStages: saved, brief: "Ads for a product" });
  expect(project).toMatchObject({ boardKind: "ads", boardFlavor: "campaign", brief: "Ads for a product" });
  expect(stagesOf("campaign", project.boardStages).find((s) => s.id === "look")!.label).toBe("Brand look");
  expect(projectSchema.safeParse(project).success).toBe(true);
  expect(seededProject("B", { boardFlavor: "nonsense" as never }).boardFlavor).toBeUndefined();
});
