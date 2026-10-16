import { test, expect } from "@playwright/test";
import { MAX_STAGES, freeCards, stageLimit, CAMPAIGN_STAGES, CLIPS_STAGES, FILM_STAGES, KIND_LABEL, NARRATED_STAGES, OPENS_ON, PREVIS_STAGES, addStage, applyStageEdit, currentStage, moveStage, removeStage, renameStage, selectionCrumb, skipStage, stageCards, stageEmpty, stagePrimary, stagesOf, stageStatus, stageId, startingRail } from "../../lib/v12/board/stages";
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

test("a Studio board is a Film board: Treatment · Pitch · Brief · Script · Cast · Locations · Elements · Storyboard · Shots · Edit · Deliver, opening on Storyboard", () => {
  const stages = stagesOf("film", null);
  expect(stages.map((s) => s.label)).toEqual(["Treatment", "Pitch", "Brief", "Script", "Cast", "Locations", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]);
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
  expect(stageStatus(FILM_STAGES.find((s) => s.id === "cast")!, CARDS, "film").state).toBe("needs");
  expect(stageStatus(FILM_STAGES.find((s) => s.id === "elements")!, CARDS, "film").state).not.toBe("needs");
});

test("rail edits are the whole saved list: rename, skip, remove, move, add; unknown or duplicate ids are dropped on read", () => {
  const stages = stagesOf("film", null);
  const renamed = renameStage(stages, "edit", "  Final cut  ");
  expect(renamed.find((s) => s.id === "edit")).toEqual({ id: "edit", label: "Final cut" });
  expect(renamed.find((s) => s.id === "brief")).toEqual({ id: "brief" });
  expect(renameStage(stages, "edit", "   ").find((s) => s.id === "edit")).toEqual({ id: "edit" });
  const skipped = stagesOf("film", skipStage(stages, "script", true));
  expect(skipped.find((s) => s.id === "script")!.skipped).toBe(true);
  expect(stagesOf("film", removeStage(stages, "script")).map((s) => s.id)).not.toContain("script");
  expect(stagesOf("film", moveStage(stages, "deliver", 0))[0].id).toBe("deliver");
  const added = addStage(stages, "storyboard", "Animatic", () => "abc");
  const after = stagesOf("film", added.saved);
  expect(after.map((s) => s.id).slice(7, 9)).toEqual(["storyboard", "custom-abc"]);
  expect(after[8]).toMatchObject({ label: "Animatic", custom: true });
  expect(stagesOf("film", [{ id: "brief" }, { id: "brief" }, { id: "gone" }, { id: "custom-x", custom: true }]).map((s) => s.id)).toEqual(["treatment", "pitch", "brief", "locations", "custom-x"]);
});

test("the rail's arrangement is part of the draft JSON: the project schema takes it and refuses nonsense", () => {
  const project = { ...newProject("Board"), boardStages: renameStage(stagesOf("film", null), "edit", "Final cut") };
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
  for (const id of ["treatment", "pitch", "brief", "script", "locations", "elements", "edit", "deliver"]) expect(stagePrimary(stage(id), CARDS, "film")).toBeNull();
  expect(stagePrimary(stage("cast"), CARDS.filter((c) => c.id !== "cast:a"), "film")).toBeNull();
  expect(stagePrimary(stage("cast"), CARDS, "campaign")).toBeNull();
});

test("a board's rail holds at most as many stages as the draft's schema takes; the next one is refused, never saved", () => {
  expect(MAX_STAGES).toBe(24);
  expect(stageLimit(23)).toBeNull();
  expect(stageLimit(24)).toBe("A board holds up to 24 stages. Remove one to add another.");
  let saved = stagesOf("film", null);
  for (let i = 0; i < 13; i++) saved = stagesOf("film", addStage(saved, null, `Extra ${i}`, () => `x${i}`).saved);
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
  expect(stageEmpty({ id: "edit", label: "Edit", custom: false }).title).toBe("Nothing to cut yet");
  expect(stageEmpty({ id: "custom-1", label: "Animatic", custom: true }).title).toBe("Animatic");
  expect(stageEmpty({ id: "custom-2", label: "Grading", custom: true })).toEqual({ title: "Grading", line: "A stage you added. Drop cards here from the Library, or ask for it in the bar.", ask: true });
  expect(selectionCrumb([])).toBeNull();
  expect(selectionCrumb(["Shot 4"])).toBe("Shot 4");
  expect(selectionCrumb(["a", "b", "c"])).toBe("3 cards");
});

/* ── Kinds (lib/v12/board/kinds.ts) ─────────────────────────────────────────────────────────────── */

test("the five kinds and their rails, in the prototype's words, each opening where the prototype opens", () => {
  const labels = (flavor: (typeof FLAVORS)[number]) => stagesOf(flavor, null).map((s) => s.label);
  expect(labels("film")).toEqual(["Treatment", "Pitch", "Brief", "Script", "Cast", "Locations", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]);
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

test("a free card (a dropped tile, a note, an upload) is no stage's own, yet is the board's: it is drawn on whichever stage is open", () => {
  const free = freeCards(CARDS);
  expect(free.map((c) => c.id)).toEqual(["note:1"]);
  expect(free.every((c) => c.region === null)).toBe(true);
  /* No stage owns it, so no stage's status or empty state counts it; every stage can draw it. */
  for (const s of FILM_STAGES) expect(stageCards(s, CARDS, "film").map((c) => c.id)).not.toContain("note:1");
  expect(freeCards([card("shot:1", "shots")])).toEqual([]);
});

/* ── v25: Film's steps, and rails saved before them (docs/plans/v25-build-plan.md, PR 4, risk 1) ─────── */

const ids = (flavor: "film" | "previs", saved: Parameters<typeof stagesOf>[1]) => stagesOf(flavor, saved).map((s) => s.id);

test("a rail saved before v25 opens with Edit where Cut was and gains Treatment, Pitch and Locations at their usual places; nothing is rewritten", () => {
  /* The eight stages Film had, the person's own rename and a stage they added kept as they were. */
  const old = [
    { id: "brief" }, { id: "script" }, { id: "cast" }, { id: "elements", label: "Props" }, { id: "custom-a", label: "Recce", custom: true },
    { id: "storyboard" }, { id: "shots" }, { id: "cut" }, { id: "deliver" },
  ];
  const copy = JSON.parse(JSON.stringify(old));
  const stages = stagesOf("film", old);
  expect(stages.map((s) => s.id)).toEqual(["treatment", "pitch", "brief", "script", "cast", "locations", "elements", "custom-a", "storyboard", "shots", "edit", "deliver"]);
  expect(stages.find((s) => s.id === "edit")).toMatchObject({ label: "Edit", builtIn: "Edit", custom: false, regions: ["cut"] });
  expect(stages.find((s) => s.id === "elements")!.label).toBe("Props");
  expect(old).toEqual(copy);
  /* The next edit saves the list as shown, so the rail is upgraded once and then stands. */
  const saved = renameStage(stages, "brief", "Idea");
  expect(saved.map((s) => s.id)).toContain("edit");
  expect(saved.map((s) => s.id)).not.toContain("cut");
  expect(ids("film", saved)).toEqual(stages.map((s) => s.id));
});

test("a rail saved before v25 keeps what its person did with Cut: a rename, a skip, its place, or its removal", () => {
  const renamed = stagesOf("film", [{ id: "brief" }, { id: "cut", label: "Final" }, { id: "deliver" }]);
  expect(renamed.find((s) => s.id === "edit")).toMatchObject({ label: "Final", builtIn: "Edit" });
  expect(stagesOf("film", [{ id: "brief" }, { id: "cut", skipped: true }, { id: "deliver" }]).find((s) => s.id === "edit")!.skipped).toBe(true);
  expect(ids("film", [{ id: "cut" }, { id: "brief" }, { id: "deliver" }]).filter((id) => id === "edit" || id === "brief" || id === "deliver")).toEqual(["edit", "brief", "deliver"]);
  expect(ids("film", [{ id: "brief" }, { id: "deliver" }])).not.toContain("edit");
  /* Both ids saved: the first one is the stage, never two. */
  expect(ids("film", [{ id: "cut" }, { id: "edit" }, { id: "brief" }]).filter((id) => id === "edit")).toHaveLength(1);
});

test("what a person removed stays removed, every time the rail is read, even all three new steps; a rail saved before them gains them", () => {
  const stages = stagesOf("film", null);
  const withoutTreatment = removeStage(stages, "treatment");
  expect(ids("film", withoutTreatment)).not.toContain("treatment");
  expect(ids("film", withoutTreatment)).toContain("pitch");
  expect(withoutTreatment).toContainEqual({ id: "treatment", removed: true });
  /* All three removed, then the rail edited again and read again: still gone. */
  let saved = removeStage(stages, "treatment");
  saved = removeStage(stagesOf("film", saved), "pitch");
  saved = removeStage(stagesOf("film", saved), "locations");
  saved = renameStage(stagesOf("film", saved), "brief", "Idea");
  for (let reads = 0; reads < 3; reads += 1) expect(ids("film", saved)).toEqual(["brief", "script", "cast", "elements", "storyboard", "shots", "edit", "deliver"]);
  /* A rail saved before them, with none of the three and none flagged, gains them. */
  expect(ids("film", [{ id: "brief" }, { id: "cast" }, { id: "cut" }])).toEqual(["treatment", "pitch", "brief", "cast", "locations", "edit"]);
  /* Flagged ones are not added back, the others are. */
  expect(ids("film", [{ id: "brief" }, { id: "pitch", removed: true }, { id: "cast" }])).toEqual(["treatment", "brief", "cast", "locations"]);
  /* The flags are not stages: they do not count toward the rail's 24, but the schema keeps them to the kind's own steps. */
  expect(projectSchema.safeParse({ ...newProject("Board"), boardStages: saved }).success).toBe(true);
  expect(saved.filter((s) => s.removed)).toHaveLength(3);
  /* The default rail is unchanged by reading it back. */
  expect(ids("film", skipStage(stages, "brief", false))).toEqual(stages.map((s) => s.id));
  /* A removed custom stage is simply gone; no flag. */
  const withCustom = addStage(stages, null, "Mine", () => "m");
  expect(removeStage(stagesOf("film", withCustom.saved), withCustom.id!).some((s) => s.id === withCustom.id)).toBe(false);
});

test("the new stages join a rail only up to the most a board holds", () => {
  const custom = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `custom-${i}`, label: `Extra ${i}`, custom: true }));
  expect(stagesOf("film", [{ id: "brief" }, ...custom(23)])).toHaveLength(MAX_STAGES);
  expect(stagesOf("film", [{ id: "brief" }, ...custom(23)]).map((s) => s.id)).not.toContain("treatment");
  const room = stagesOf("film", [{ id: "brief" }, ...custom(22)]).map((s) => s.id);
  expect(room).toHaveLength(MAX_STAGES);
  expect(room.slice(0, 2)).toEqual(["treatment", "brief"]);
});

test("the address ?stage=cut still opens Edit; other kinds are untouched", () => {
  const stages = stagesOf("film", null);
  expect(currentStage(stages, "cut", "film")!.id).toBe("edit");
  expect(currentStage(stages, "edit", "film")!.id).toBe("edit");
  expect(stageId("film", "cut")).toBe("edit");
  expect(stageId("campaign", "cut")).toBe("cut");
  expect(ids("previs", null)).toEqual(["brief", "script", "cast", "elements", "storyboard", "animatic", "ppm-deck"]);
  expect(ids("previs", [{ id: "brief" }, { id: "cast" }])).toEqual(["brief", "cast"]);
});

test("Pitch, Treatment and Locations have no cards of their own yet: no card of today's board disappears", () => {
  const every = new Set(FILM_STAGES.flatMap((d) => d.regions));
  for (const r of ["brief", "looks", "storyboard", "shots", "cast", "cut", "deliver", "next", "made"] as const) expect(every.has(r)).toBe(true);
  for (const id of ["treatment", "pitch", "locations"]) {
    expect(FILM_STAGES.find((d) => d.id === id)!.regions).toEqual([]);
    expect(stageCards({ id, regions: [] }, CARDS, "film")).toEqual([]);
  }
});

test("a board started with a shorter rail (Treatment and Locations left out, Elements skipped) keeps it, however it is read or edited", () => {
  const rail = startingRail("film", { without: ["treatment", "locations"], skipped: ["elements"] });
  expect(rail).toContainEqual({ id: "treatment", removed: true });
  expect(rail).toContainEqual({ id: "locations", removed: true });
  expect(rail).toContainEqual({ id: "elements", skipped: true });
  const want = ["pitch", "brief", "script", "cast", "elements", "storyboard", "shots", "edit", "deliver"];
  expect(ids("film", rail)).toEqual(want);
  expect(stagesOf("film", rail).find((s) => s.id === "elements")!.skipped).toBe(true);
  /* Removing Pitch later does not bring the others back. */
  const lessPitch = removeStage(stagesOf("film", rail), "pitch");
  expect(ids("film", lessPitch)).toEqual(want.slice(1));
  expect(projectSchema.safeParse({ ...newProject("Board"), boardStages: lessPitch }).success).toBe(true);
  expect(startingRail("film")).toEqual(stagesOf("film", null).map((s) => ({ id: s.id })));
  expect(startingRail("previs", { without: ["script"] }).map((s) => s.id)).toContain("script");
});

test("a removed flag is only for the kind's own stages: the schema refuses it on a custom stage, and a rail never draws more than it holds", () => {
  const project = newProject("Board");
  expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "custom-a", custom: true, removed: true }] }).success).toBe(false);
  expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "treatment", removed: true }] }).success).toBe(true);
  /* The shape that would have drawn 36: 24 custom stages and 12 flagged ones (read from a draft that never went through the schema). */
  const custom = Array.from({ length: 24 }, (_, i) => ({ id: `custom-${i}`, label: `Extra ${i}`, custom: true }));
  const flagged = Array.from({ length: 12 }, (_, i) => ({ id: `custom-gone${i}`, label: `Gone ${i}`, custom: true, removed: true }));
  const drawn = stagesOf("film", [...custom, ...flagged]);
  expect(drawn.length).toBeLessThanOrEqual(MAX_STAGES);
  expect(drawn.some((s) => s.id.startsWith("custom-gone"))).toBe(false);
  expect(projectSchema.safeParse({ ...project, boardStages: [...custom, ...flagged] }).success).toBe(false);
});
