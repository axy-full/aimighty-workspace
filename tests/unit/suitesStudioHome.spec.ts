import { test, expect } from "@playwright/test";
import { assetsRowLabel, recentTakes, stageCards, studioStages, suiteTiles, upNext } from "../../lib/shell/studio-home";
import { shellSuite } from "../../lib/shell/ia";
import { newProject } from "../../lib/workbench/studio";
import type { LibraryEntry } from "../../lib/workspace/library";

const take = (id: string, kind: "GEN" | "UPLOAD" = "GEN"): LibraryEntry =>
  ({ take: { id, sourceId: id, kind, name: id, version: "v1", meta: "", credits: null, usd: null, status: "review", sha256: null, createdAt: 0 }, asset: {} as LibraryEntry["asset"], url: null, media: null });

/** Particl Mobile.dc.html › STUDIO HOME: eight cards, one per stage, every line from the project. */
test("the home is a Studio page outside the strip; the cards are the eight stages in order", () => {
  const home = shellSuite("studio").pages.find((p) => p.id === "home");
  expect(home).toMatchObject({ own: true, phoneOnly: true, n: "" });
  expect(home?.legacy).toEqual({ suite: "particl", page: "brief" });
  expect(shellSuite("studio").pages[0].id).toBe("brief");
  expect(studioStages().map((p) => p.id)).toEqual(["brief", "boards", "cast", "astra", "rig", "takes", "edit", "deliver"]);
});

test("every card's line and dot come from the project and the library", () => {
  const empty = newProject("Coastal light study");
  const cards = stageCards(empty, []);
  expect(cards.map((c) => c.status)).toEqual(["ready", "ready", "ready", "ready", "ready", "ready", "ready", "ready"]);
  expect(cards.find((c) => c.id === "brief")?.meta).toBe("empty");
  expect(cards.find((c) => c.id === "deliver")?.meta).toBe(`${empty.aspect} · ${empty.fps} fps`);

  const busy = {
    ...empty,
    brief: "A fox crosses a frozen harbour at dusk",
    shots: [{ id: "s1", name: "The crossing", assetId: "", duration: 5, sourceIn: 0, note: "" }, { id: "s2", name: "The turn", assetId: "gen_1", duration: 5, sourceIn: 0, note: "" }],
    assets: [{ id: "a1", category: "Character", name: "Mira" }, { id: "a2", category: "Storyboard", name: "Frame 1" }] as unknown as typeof empty.assets,
  };
  const live = stageCards(busy, [take("gen_1"), take("up_1", "UPLOAD")]);
  expect(live.find((c) => c.id === "brief")).toMatchObject({ meta: "8 words", status: "done" });
  expect(live.find((c) => c.id === "rig")).toMatchObject({ meta: "2 shots · 1 rendered", status: "progress" });
  expect(live.find((c) => c.id === "takes")).toMatchObject({ meta: "1 take", status: "done" });
  expect(live.find((c) => c.id === "cast")).toMatchObject({ meta: "1 identity · 0 elements", status: "done" });
  expect(live.find((c) => c.id === "boards")).toMatchObject({ meta: "1 frame", status: "done" });
  expect(upNext(busy)).toEqual({ id: "s1", index: 1, name: "The crossing" });
  expect(upNext({ ...busy, shots: [busy.shots[1]] })).toBeNull();
  expect(recentTakes([take("g1"), take("u1", "UPLOAD"), take("g2")]).map((e) => e.take.id)).toEqual(["g1", "g2"]);
});

/* GLASS_SPEC §3 › Home: six tiles in order, the lines verbatim, the facts from the figures given. */
test("the Home tiles carry the prototype's lines and live facts; the Assets row counts the project", () => {
  const cards = stageCards({ ...newProject("Dune Studies"), brief: "A fox crosses a frozen harbour at dusk" }, []);
  const facts = { rendering: 0, videoEngine: "Seedance 2.5", adMode: "UGC", adSeconds: 15, viralResolution: "720p", awaiting: 2, seats: 7 };
  const tiles = suiteTiles(cards, facts);
  expect(tiles.map((t) => t.id)).toEqual(["studio", "gen", "business", "viral", "atomik", "crew"]);
  expect(tiles.map((t) => t.line)).toEqual([
    "Brief to delivery, eight stages.", "Video, images, audio, 3D — one composer.", "Marketing Studio: product, presenter, ad.",
    "Genjutsu: motion transfer, object swap.", "Plans, prices, waits for your word.", "One Grok agent per department.",
  ]);
  expect(tiles.map((t) => t.fact)).toEqual(["1 of 8 done", "Seedance 2.5 ready", "UGC · 15 s · quoted in Ads", "720p · quoted on the source", "2 awaiting approval", "7 seats"]);
  expect(tiles.map((t) => t.color)).toEqual(["#0A84FF", "#BF5AF2", "#FF9F0A", "#FF453A", "#30D158", "#BF5AF2"]);
  expect(suiteTiles(cards, { ...facts, rendering: 2, seats: 1 }).map((t) => t.fact)).toEqual(expect.arrayContaining(["2 rendering", "1 seat"]));
  expect(suiteTiles(cards, { ...facts, seats: null })[5].fact).toBe("seats loading");
  expect(assetsRowLabel([], "Dune Studies")).toBe("0 in Dune Studies");
  expect(assetsRowLabel([{} as never, {} as never], null)).toBe("2 in this project");
});
