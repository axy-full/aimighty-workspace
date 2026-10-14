import { test, expect } from "@playwright/test";
import { buildRegistry } from "../../components/graphite/board/cards";
import { studioBoard } from "../../components/graphite/board/studio";
import { adsBoard } from "../../components/graphite/board/ads";
import { socialBoard } from "../../components/graphite/board/social";
import { showsBeatTable, stageRows, type StageRow } from "../../components/graphite/board/stage-list/rows";
import { EMPTY_EXTRA } from "../../components/graphite/board/ads/ads-session";
import { builtInStages, freeCards, stageCards, stagesOf } from "../../lib/v12/board/stages";
import type { Flavor } from "../../lib/v12/board/kinds";
import type { BoardCard, BoardSource } from "../../lib/board/types";
import type { Asset, CanvasNode, Project } from "../../lib/workbench/studio";
import { EMPTY_MOLECULR } from "../../lib/workbench/moleculr";
import { EMPTY_BRAND_KIT } from "../../lib/workbench/moleculr-creative";
import type { SocialPost } from "../../lib/social/posts";
import type { LibraryEntry } from "../../lib/workspace/library";
import { entries, gen, project } from "./demo-s05-fixtures";

/*
 * One board, four lenses, PR 2: every stage's List shows the stage's OWN content as rows (the brief's fields, the cast and the elements, the cut's clips, the delivery's
 * specs, a campaign's hooks and ads, a social board's sources and posts), and they are the very cards the Canvas draws for that stage. The beat table stays for Script,
 * Storyboard and Shots. Neutral names only.
 */
const clipAsset = (id: string, genId: string, name = "Clip"): Asset => ({ id, name, kind: "video", category: "Take", url: `/api/media/${genId}`, description: "", prompt: "", status: "Draft", locked: false, generationId: genId } as unknown as Asset);
const node = (id: string, title: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title, type: "character", x: 0, y: 0, width: 254, linked: [], ...extra } as CanvasNode);

/** A film: a brief, two cast cards, a place and a prop, three shots with two approved takes in a two-clip cut. */
function film(): { src: BoardSource; cards: BoardCard[] } {
  const base = project({
    brief: "A runner meets the dawn.", direction: "Cold light, long lenses.",
    nodes: [...project().nodes,
      node("node-cast01", "Lead", { refKind: "cast", text: "ivory suit" }), node("node-cast02", "Friend", { refKind: "cast" }),
      node("node-place1", "The hill", { type: "element", refKind: "environment" }), node("node-prop01", "Brass bell", { type: "element", refKind: "element" }),
      { id: "node-brief01", title: "Notes", type: "brief", x: 0, y: 0, width: 254, linked: [], text: "Keep it quiet." } as CanvasNode],
    assets: [clipAsset("a1", "g1"), clipAsset("a2", "g2")],
    shots: [{ id: "c1", name: "Clip 1", assetId: "a1", duration: 120, sourceIn: 0, note: "" }, { id: "c2", name: "Clip 2", assetId: "a2", duration: 120, sourceIn: 0, note: "" }],
  });
  const library = entries([gen({ id: "g1", shotId: "s1", reviewState: "approved", approvedBy: "Person One" }), gen({ id: "g2", shotId: "s2", reviewState: "approved", approvedBy: "Person One" }), gen({ id: "g3", shotId: "s3" })]);
  const src: BoardSource = { kind: "studio", project: base, shots: [], jobs: [], library, masters: new Set(), agent: null, now: 0, lenses: true };
  return { src, cards: buildRegistry(studioBoard.sets).derive(src) };
}
/** What the stage's Canvas draws: its own cards and the board's free ones. */
const drawn = (cards: BoardCard[], flavor: Flavor, id: string) => {
  const stage = stagesOf(flavor, null).find((s) => s.id === id)!;
  return [...stageCards(stage, cards, flavor), ...freeCards(cards)];
};
const titles = (rows: StageRow[]) => rows.map((r) => r.title);

test("every card a stage's Canvas draws has its row in the stage's List, and no row names a card the stage does not draw", () => {
  const { cards } = film();
  for (const flavor of ["film", "previs"] as const) {
    for (const stage of stagesOf(flavor, null)) {
      const canvas = drawn(cards, flavor, stage.id);
      const rows = stageRows(canvas);
      const ids = new Set(canvas.map((c) => c.id));
      for (const row of rows) expect(ids.has(row.cardId!), `${flavor}/${stage.id}: ${row.title}`).toBe(true);
      /* Every card but a group frame (it frames its children) is in the list. */
      for (const card of canvas.filter((c) => c.kind !== "group")) expect(rows.some((r) => r.cardId === card.id), `${flavor}/${stage.id}: ${card.id}`).toBe(true);
    }
  }
});

test("Brief lists the brief's fields, the briefs on the board and the looks", () => {
  const rows = stageRows(drawn(film().cards, "film", "brief"));
  expect(rows.filter((r) => r.cardId === "doc:brief").map((r) => [r.kind, r.title, r.detail])).toEqual([
    ["Brief", "What we are making", "A runner meets the dawn."], ["Brief", "Look", "Cold light, long lenses."], ["Brief", "Format", "16:9 · 24 fps · 15 s"],
  ]);
  expect(rows.find((r) => r.cardId === "node-brief01")).toMatchObject({ kind: "Brief", title: "Notes", detail: "Keep it quiet." });
});

test("Cast and Elements list their own cards: characters on one, places and props on the other", () => {
  const { cards } = film();
  const cast = stageRows(drawn(cards, "film", "cast"));
  expect(cast.map((r) => [r.kind, r.title]).filter(([k]) => k !== "Note")).toEqual([["Cast", "Lead"], ["Cast", "Friend"]]);
  expect(cast.find((r) => r.title === "Lead")!.detail).toBe("ivory suit");
  const elements = stageRows(drawn(cards, "film", "elements"));
  expect(elements.map((r) => [r.kind, r.title]).filter(([k]) => k !== "Note")).toEqual([["Environment", "The hill"], ["Element", "Brass bell"]]);
  /* The two stages share a frame and not a card (the board's free notes are on both). */
  const own = (rows: StageRow[]) => rows.filter((r) => r.kind !== "Note").map((r) => r.cardId);
  expect(new Set([...own(cast), ...own(elements)]).size).toBe(own(cast).length + own(elements).length);
});

test("Cut lists the clips of the cut in order, each approved or not, and the shot still waiting", () => {
  const rows = stageRows(drawn(film().cards, "film", "cut"));
  const clips = rows.filter((r) => r.kind === "Clip");
  expect(clips.map((r) => [r.title, r.detail, r.state])).toEqual([["Shot 1", "5 s", "Approved"], ["Shot 2", "5 s", "Approved"]]);
  expect(rows.filter((r) => r.kind === "Shot").map((r) => [r.title, r.more])).toEqual([["Shot 3", "needs review"]]);
});

test("Deliver lists the delivery's specs, answered or waiting on the cut", () => {
  const rows = stageRows(drawn(film().cards, "film", "deliver"));
  const specs = rows.filter((r) => r.kind === "Spec");
  expect(specs.map((r) => r.title)).toEqual(["Aspect", "Frame rate", "Duration", "Loudness"]);
  expect(specs.find((r) => r.title === "Aspect")).toMatchObject({ detail: "16:9", state: "Waiting on the cut" });
  expect(specs.find((r) => r.title === "Frame rate")).toMatchObject({ detail: "24 fps" });
});

test("Pre-vis's Animatic lists the shots and the cut", () => {
  const rows = stageRows(drawn(film().cards, "previs", "animatic"));
  expect(rows.filter((r) => r.cardId === "n1" || r.cardId === "n2" || r.cardId === "n3").map((r) => r.title)).toEqual(["Shot 1 · Extreme wide", "Shot 2 · Medium", "Shot 3 · Close-up"]);
  expect(rows.some((r) => r.kind === "Clip")).toBe(true);
});

test("the beat table is kept for Script, Storyboard and Shots of a Film or Pre-vis, and for no other stage or kind", () => {
  for (const flavor of ["film", "previs"] as const) {
    for (const stage of builtInStages(flavor)) expect(showsBeatTable(stage.id, flavor), `${flavor}/${stage.id}`).toBe(["script", "storyboard", "shots"].includes(stage.id));
  }
  for (const flavor of ["campaign", "narrated", "clips"] as const) for (const stage of builtInStages(flavor)) expect(showsBeatTable(stage.id, flavor), `${flavor}/${stage.id}`).toBe(false);
});

test("a campaign lists its hooks, its formats and its ads", () => {
  const moleculr = { ...EMPTY_MOLECULR, productName: "Glass bottle", hooks: ["Water, simply.", "Clear by design."], brandKit: { ...EMPTY_BRAND_KIT, name: "Clear Co", colors: ["#0A84FF"] } };
  const src: BoardSource = { kind: "ads", project: { ...project({ production: undefined, nodes: [] }), moleculr } as Project, shots: [], jobs: [], library: [], masters: new Set(), extra: EMPTY_EXTRA, agent: null, now: 0, lenses: true };
  const cards = buildRegistry(adsBoard.sets).derive(src);
  const variants = stageRows(drawn(cards, "campaign", "variants"));
  expect(variants.filter((r) => r.kind === "Hook").map((r) => r.title)).toEqual(["Water, simply.", "Clear by design."]);
  for (const stage of stagesOf("campaign", null)) {
    const canvas = drawn(cards, "campaign", stage.id);
    const rows = stageRows(canvas);
    for (const card of canvas.filter((c) => c.kind !== "group")) expect(rows.some((r) => r.cardId === card.id), `campaign/${stage.id}: ${card.id}`).toBe(true);
  }
});

test("a social board lists its sources and its posts, and every card of every stage has a row", () => {
  const video = (id: string, seconds: number): LibraryEntry => ({
    take: { id: `upload:${id}`, sourceId: id, kind: "UPLOAD", name: `${id}.mp4`, version: "v1", meta: "", credits: null, usd: null, status: "upload", sha256: null, createdAt: 1 },
    asset: { origin: "upload", value: { id, durationS: seconds } }, url: `/api/uploads/${id}`, media: "video",
  } as unknown as LibraryEntry);
  const src: BoardSource = { kind: "social", project: project({ production: undefined, nodes: [] }), shots: [], jobs: [], library: [video("a", 6), video("b", 45)], masters: new Set(), agent: null, now: 0, lenses: true };
  const cards = buildRegistry(socialBoard.sets).derive(src);
  const post: SocialPost = { id: "post-1", platform: "instagram", format: "Reel", clip: "Clip 1 · 0:14", aspect: "9:16", state: "draft", at: null, failure: null, approvedBy: null } as unknown as SocialPost;
  const sourceRows = stageRows(drawn(cards, "clips", "source"));
  expect(sourceRows.filter((r) => r.kind === "Source").map((r) => [r.title, r.detail])).toEqual([["a.mp4", "0:06"], ["b.mp4", "0:45"]]);
  for (const flavor of ["narrated", "clips"] as const) {
    for (const stage of stagesOf(flavor, null)) {
      const canvas = drawn(cards, flavor, stage.id);
      const rows = stageRows(canvas, { posts: [post] });
      for (const card of canvas.filter((c) => c.kind !== "group")) expect(rows.some((r) => r.cardId === card.id), `${flavor}/${stage.id}: ${card.id}`).toBe(true);
    }
  }
  /* A post card names a post by id: its row is the post's words and state. */
  const postCard = { id: "social:post-1", kind: "social-post", region: "posts", order: 0, state: "empty", data: { id: "post-1" } } as BoardCard;
  expect(stageRows([postCard], { posts: [post] })[0]).toMatchObject({ kind: "Post", title: expect.stringContaining("Reel"), detail: "Clip 1 · 0:14", state: "Draft" });
});

test("a free card (a note, a text, a dropped tile) is a row on every stage that draws it", () => {
  const cards: BoardCard[] = [
    { id: "n1", kind: "note", region: null, order: 0, state: "done", at: { x: 0, y: 0 }, data: { title: "", text: "Ask about the second location." } },
    { id: "l1", kind: "label", region: null, order: 1, state: "done", at: { x: 0, y: 0 }, data: { title: "Reshoots" } },
  ];
  expect(stageRows(cards).map((r) => [r.kind, r.title])).toEqual([["Note", "Ask about the second location."], ["Text", "Reshoots"]]);
  expect(titles(stageRows([]))).toEqual([]);
});
