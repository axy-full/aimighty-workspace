import { test, expect } from "@playwright/test";
import { buildRegistry } from "../../components/graphite/board/cards";
import { placeBoard } from "../../components/graphite/board/layout-cards";
import { socialBoard } from "../../components/graphite/board/social";
import { SOCIAL_GROUP, clock, fitsQuickTool, socialCards, sources } from "../../components/graphite/board/social/social-model";
import { railStatus } from "../../lib/board/regions";
import type { BoardSource } from "../../lib/board/types";
import { newProject } from "../../lib/workbench/studio";
import type { LibraryEntry } from "../../lib/workspace/library";

/* Stream 11 · the Social board's cards, from the project's Library alone. */
const video = (id: string, seconds: number | null, origin: "upload" | "generation" = "upload", model = ""): LibraryEntry => ({
  take: { id: `${origin}:${id}`, sourceId: id, kind: origin === "upload" ? "UPLOAD" : "GEN", name: `${id}.mp4`, version: "v1", meta: "", credits: null, usd: null, status: origin === "upload" ? "uploaded" : "review", sha256: null, createdAt: 1 },
  asset: { origin, value: origin === "upload" ? { id, durationS: seconds } : { id, model, kind: "video", params: {}, status: "succeeded", durationS: seconds, createdAt: 1 } } as never,
  url: `/api/uploads/${id}`, media: "video",
});
const src = (library: LibraryEntry[]): BoardSource => ({ kind: "social", project: newProject("Fixture"), shots: [], jobs: [], library, masters: new Set(), agent: null, now: 0 });

test("a quick tool takes one source of 4 to 8 seconds", () => {
  expect([3.9, 4, 8, 8.1, null].map(fitsQuickTool)).toEqual([false, true, true, false, false]);
  expect([null, 9, 70].map(clock)).toEqual(["", "0:09", "1:10"]);
});

test("sources are the project's videos, uploads and Particl's own takes, but not the transform results", () => {
  const list = sources([video("a", 6), video("b", 45), video("c", 7, "generation", "higgsfield/kling-3.0-standard")]);
  expect(list.map((s) => [s.id, s.fits, s.origin])).toEqual([["upload:a", true, "upload"], ["upload:b", false, "upload"], ["generation:c", true, "generation"]]);
  expect(list[0].media).toMatchObject({ sourceId: "a", kind: "video", seconds: 6 });
});

test("an empty Library draws nothing (the board shows its source box); a source draws every section, the unbuilt ones honestly", () => {
  expect(socialCards(src([]))).toEqual([]);
  const cards = socialCards(src([video("a", 6)]));
  expect(cards.map((c) => c.id)).toEqual([
    SOCIAL_GROUP.source, "social:source:upload:a", SOCIAL_GROUP.clips, "social:clips", SOCIAL_GROUP.hooks, "social:hooks", SOCIAL_GROUP.effects, "social:effects", SOCIAL_GROUP.posts, "social:narrated", "social:posts",
  ]);
  const off = cards.filter((c) => c.kind === "social-unavailable");
  expect(off.map((c) => (c.data as { line: string }).line)).toEqual(Array(4).fill("Not in Particl yet"));
  /* No price and no sample result anywhere in what is not built. */
  expect(JSON.stringify(cards)).not.toMatch(/\bcr\b|\$|score|Instagram|TikTok|YouTube/);
});

test("the rail: Source is done, Effects names its two tools, everything else is not built", () => {
  const registry = buildRegistry(socialBoard.sets);
  const placed = placeBoard(registry.derive(src([video("a", 6)])), registry.defs, socialBoard.bands, "16:9");
  expect(placed.cards.length).toBe(11);
  const status = railStatus(socialBoard.rail, placed.cards);
  expect([...status.keys()]).toEqual(["source", "clips", "hooks", "effects", "posts"]);
  expect(status.get("source")).toMatchObject({ state: "done", summary: "a.mp4 · 0:06" });
  expect(status.get("effects")!.summary).toBe("Motion transfer · Object swap");
  expect(status.get("clips")).toMatchObject({ state: "empty", summary: "Not in Particl yet" });
  expect(status.get("posts")!.summary).toBe("Not in Particl yet");
  /* Hook review and Effects sit side by side in one band. */
  expect(placed.boxes.get(SOCIAL_GROUP.hooks)!.y).toBe(placed.boxes.get(SOCIAL_GROUP.effects)!.y);
});
