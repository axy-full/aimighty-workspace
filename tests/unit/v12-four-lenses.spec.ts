import { test, expect } from "@playwright/test";
import { newProject, type Project } from "../../lib/workbench/studio";
import type { BeatSheet } from "../../lib/production/beats";
import type { BoardSource } from "../../lib/board/types";
import { shotRows as listRows } from "../../lib/board/list";
import { derivePlanCards } from "../../components/graphite/board/cards/plan/derive";
import { deriveScript } from "../../components/graphite/board/cards/doc/script-cards";
import { shotRows as docRows } from "../../components/graphite/board/cards/doc/model";
import { builtInStages, stageCards, stagesOf, stageEmpty } from "../../lib/v12/board/stages";
import { defaultLens, lensFor, lensKey, readLenses, saveLens } from "../../lib/v12/board/lens";
import { STUDIO_BANDS } from "../../lib/board/regions";

/*
 * One board, four lenses (owner, 13 Oct): every view of a stage shows the same content of that stage. The rows here are what the List shows; the cards are what the Canvas
 * shows. They are held to each other, stage by stage, and the defaults and the memory of a person's own switch are held to the owner's table.
 */
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NOW = "2026-10-13T10:00:00.000Z";
const sheet = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: NOW,
  scenes: [
    { id: "scene-a", heading: "EXT. HILL - DAWN", summary: "", beats: [], characters: [], locations: [], props: [], shots: [
      { id: "shot-1", description: "Fog lifts.", framing: "Extreme wide", movement: "Locked off", lighting: "", sound: "", duration: 4 },
      { id: "shot-2", description: "A runner.", framing: "Medium", movement: "Slow push", lighting: "", sound: "", duration: 6 },
    ] },
    { id: "scene-b", heading: "", summary: "", beats: [], characters: [], locations: [], props: [], shots: [
      { id: "shot-3", description: "", framing: "Close-up", movement: "Held", lighting: "", sound: "" },
    ] },
  ],
});
const project = (over: Partial<Project> = {}): Project => ({ ...newProject("Film"), aspect: "16:9", fps: 24, brief: "A runner at dawn.", direction: "Cold light.", script: "EXT. HILL - DAWN\n\nFog lifts.", production: { beats: sheet() }, ...over });
const src = (p: Project, extra: Partial<BoardSource> = {}): BoardSource => ({ kind: "studio", project: p, shots: [], jobs: [], library: [], masters: new Set(), agent: null, now: 0, ...extra });

test("Script: the Canvas shows the script and one card per beat, in the beat sheet's order, exactly the rows the List shows", () => {
  const cards = deriveScript(project());
  expect(cards.map((c) => [c.id, c.kind, c.region, c.order])).toEqual([
    ["doc:script", "doc", "script", 0], ["beat:shot-1", "doc", "script", 1], ["beat:shot-2", "doc", "script", 2], ["beat:shot-3", "doc", "script", 3],
  ]);
  /* One beat card per List row, same order, same words. */
  const rows = docRows(project().production!.beats);
  const beats = cards.filter((c) => (c.data as { variant: string }).variant === "beat");
  expect(beats.map((c) => (c.data as { shotId: string }).shotId)).toEqual(rows.map((r) => r.id));
  expect(beats.map((c) => (c.data as { text: string }).text)).toEqual(rows.map((r) => r.action));
  expect(beats.map((c) => (c.data as { title: string }).title)).toEqual(["01 · EXT. HILL - DAWN", "02 · EXT. HILL - DAWN", "Shot 03"]);
  /* The script card is the script, whole. */
  expect(cards[0].data).toEqual({ variant: "script", text: project().script });
  /* Plain data only. */
  expect(JSON.parse(JSON.stringify(cards))).toEqual(cards);
  /* No script and no beats, no cards: the stage is empty in every view. */
  expect(deriveScript(project({ script: "", production: undefined }))).toEqual([]);
  expect(deriveScript(project({ script: "  \n" }))).toHaveLength(3);
});

test("the cards reach the Script stage on the new interface only, and the stage draws them (Film and Pre-vis)", () => {
  const off = derivePlanCards(src(project()));
  expect(off.some((c) => c.region === "script")).toBe(false);
  const on = derivePlanCards(src(project(), { lenses: true }));
  for (const flavor of ["film", "previs"] as const) {
    const stage = stagesOf(flavor, null).find((s) => s.id === "script")!;
    expect(stage.regions).toEqual(["script"]);
    expect(stageCards(stage, on, flavor).map((c) => c.id)).toEqual(["doc:script", "beat:shot-1", "beat:shot-2", "beat:shot-3"]);
    /* Every other stage keeps its own cards: none of the script's is on the Brief. */
    expect(stageCards(stagesOf(flavor, null).find((s) => s.id === "brief")!, on, flavor).some((c) => c.region === "script")).toBe(false);
  }
  /* The band exists, first, so the script lays out above the rest. */
  expect(STUDIO_BANDS[0]).toEqual(["script"]);
});

test("Storyboard: a frame per beat stays on the Storyboard after the first take on the new interface; today's board gives way as it did", () => {
  const taken = { state: "running", paid: [{ seq: 1, tool: "render", state: "rendering" }] } as unknown as NonNullable<BoardSource["agent"]>;
  const frames = (cards: ReturnType<typeof derivePlanCards>) => cards.filter((c) => c.kind === "frame").map((c) => c.id);
  expect(frames(derivePlanCards(src(project(), { agent: taken })))).toEqual([]);
  const kept = derivePlanCards(src(project(), { agent: taken, lenses: true }));
  /* A frame for each shot of the beat sheet: the same count as the List's rows. */
  expect(frames(kept)).toEqual(["frame:shot-1", "frame:shot-2", "frame:shot-3"]);
  expect(frames(kept)).toHaveLength(listRows(project(), []).length);
  /* The plan, once the shots have taken over, still stands with the shots (the Shots stage), not in the Storyboard's group. */
  const plan = { state: "awaiting_approval", paid: [{ seq: 1, tool: "render", state: "approved" }] } as unknown as NonNullable<BoardSource["agent"]>;
  const withPlan = derivePlanCards(src(project(), { agent: plan, lenses: true }));
  expect(withPlan.find((c) => c.kind === "plan")?.region).toBe("shots");
});

test("Shots: the List lists the board's shot cards when there is no beat sheet", () => {
  const bare = project({ script: "", production: undefined });
  const shots = [
    { id: "n1", index: 1, name: "Opening", note: "", status: "draft", durationS: 4 },
    { id: "n2", index: 2, name: "Second", note: "", status: "draft", durationS: null },
  ] as never;
  expect(listRows(bare, shots).map((r) => [r.id, r.cardId])).toEqual([["n1", "n1"], ["n2", "n2"]]);
  /* With a beat sheet it is the beats. */
  expect(listRows(project(), []).map((r) => r.id)).toEqual(["shot-1", "shot-2", "shot-3"]);
});

test("a stage with nothing yet says the same thing in every view (one message per stage), custom stages included", () => {
  expect(stageEmpty({ id: "moments", label: "Moments", custom: false }).title).toBe("No moments yet");
  expect(stageEmpty({ id: "voice", label: "Voice", custom: false }).title).toBe("No narration yet");
  const custom = stageEmpty({ id: "custom-1", label: "Notes", custom: true });
  expect(custom).toMatchObject({ title: "Notes", ask: true });
  /* The words are a function of the stage alone, so Canvas, List and Rig cannot disagree. */
  expect(stageEmpty({ id: "elements", label: "Elements", custom: false })).toEqual(stageEmpty({ id: "elements", label: "Elements", custom: false }));
  /* Moments and Voice draw no cards of their own. */
  expect(builtInStages("clips").find((s) => s.id === "moments")!.regions).toEqual([]);
  expect(builtInStages("narrated").find((s) => s.id === "voice")!.regions).toEqual([]);
});

test("each stage opens in its natural lens: Script List, Storyboard, Shots, Cast, Elements and Cut Canvas (Cut until Strip is built)", () => {
  for (const flavor of ["film", "previs"] as const) expect(defaultLens("script", flavor)).toBe("list");
  for (const id of ["brief", "storyboard", "shots", "cast", "elements", "cut", "deliver", "animatic", "ppm-deck", "moments", "voice", "custom-1"]) expect(defaultLens(id, "film"), id).toBe("canvas");
  /* Another kind's Script is not a beat sheet. */
  expect(defaultLens("script", "narrated")).toBe("canvas");
  expect(defaultLens(null, "film")).toBe("canvas");
});

test("a person's own switch is remembered per board and per stage on this device, and beats the default", () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  try {
    expect(lensKey("scope-1", "prj_1")).toBe("particl:board-lens:scope-1:prj_1");
    expect(readLenses("scope-1", "prj_1")).toEqual({});
    const after = saveLens("scope-1", "prj_1", "script", "canvas");
    expect(after).toEqual({ script: "canvas" });
    saveLens("scope-1", "prj_1", "storyboard", "list");
    expect(readLenses("scope-1", "prj_1")).toEqual({ script: "canvas", storyboard: "list" });
    expect(lensFor("script", "film", readLenses("scope-1", "prj_1"))).toBe("canvas");
    expect(lensFor("storyboard", "film", readLenses("scope-1", "prj_1"))).toBe("list");
    expect(lensFor("shots", "film", readLenses("scope-1", "prj_1"))).toBe("canvas");
    /* Another board, another workspace scope: nothing. */
    expect(readLenses("scope-1", "prj_2")).toEqual({});
    expect(readLenses("scope-2", "prj_1")).toEqual({});
    /* A damaged entry, or an unknown lens, is nothing, never an error. */
    store.set(lensKey("scope-1", "prj_3"), "{not json");
    expect(readLenses("scope-1", "prj_3")).toEqual({});
    store.set(lensKey("scope-1", "prj_4"), JSON.stringify({ script: "strip", shots: "list", cut: 3 }));
    expect(readLenses("scope-1", "prj_4")).toEqual({ shots: "list" });
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
