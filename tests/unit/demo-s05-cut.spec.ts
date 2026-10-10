import { test, expect } from "@playwright/test";
import { cutMeta, cutOf, deriveCut, deliverRows, sequenceProblem, type CutCardData } from "../../components/graphite/board/cards/cut/cut-model";
import { runtime, specRows } from "../../components/graphite/board/cards/deliver/spec-check";
import { shotTakes } from "../../components/graphite/board/cards/take/take-model";
import type { Asset, Project } from "../../lib/workbench/studio";
import { entries, gen, project } from "./demo-s05-fixtures";

/* Stream 5 · the Cut and Deliver cards (design/particl-graphite/README.md § 3.1 i; DECISIONS 39 e). Neutral names only. */

const clipAsset = (id: string, genId: string, name = "Clip"): Asset => ({ id, name, kind: "video", category: "Take", url: `/api/media/${genId}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], generationId: genId, mime: "video/mp4" });
const sequence = (genIds: string[]): Partial<Project> => ({
  assets: genIds.map((g, i) => clipAsset(`a${i + 1}`, g)),
  shots: genIds.map((g, i) => ({ id: `c${i + 1}`, name: `Clip ${i + 1}`, assetId: `a${i + 1}`, duration: 120, sourceIn: 0, note: "" })),
});

/* Shot 1 and Shot 2 are approved and in the cut (5 s each at 24 fps); Shot 3 has a take that waits for review. */
const library = () => entries([
  gen({ id: "g1", shotId: "s1", reviewState: "approved", approvedBy: "Person One" }),
  gen({ id: "g2", shotId: "s2", reviewState: "approved", approvedBy: "Person One" }),
  gen({ id: "g3", shotId: "s3" }),
]);

test("2 approved takes · 0:10, every shot 5 s, Shot 3 waiting for review; the delivery checks read pending", () => {
  const p = project(sequence(["g1", "g2"]));
  const cut = cutOf(p, shotTakes(p, library()), library());
  expect(cut.clips.map((c) => [c.label, c.seconds, c.approved])).toEqual([["Shot 1", 5, true], ["Shot 2", 5, true]]);
  expect(cut.approved).toBe(2);
  expect(cut.seconds).toBe(10);
  expect(cut.waiting).toEqual([{ shot: 3, word: "needs review" }]);
  expect(cut.complete).toBe(false);
  expect(cutMeta(cut)).toBe("2 approved takes · 0:10");
  const rows = deliverRows(cut);
  expect(rows.map((r) => [r.key, r.value, r.mark, r.word])).toEqual([
    ["aspect", "16:9", "pending", "pending"],
    ["fps", "24 fps", "pending", "pending"],
    ["duration", "00:10", "pending", "pending"],
    ["loudness", "Not checked · Broadcast", "none", null],
  ]);
});

test("once every shot has its approved take in the cut the checks are answered, and the length is shown but never ticked", () => {
  const lib = entries([gen({ id: "g1", shotId: "s1", reviewState: "approved" }), gen({ id: "g2", shotId: "s2", reviewState: "approved" }), gen({ id: "g3", shotId: "s3", reviewState: "approved" })]);
  const p = project(sequence(["g1", "g2", "g3"]));
  const cut = cutOf(p, shotTakes(p, lib), lib);
  expect(cut.complete).toBe(true);
  expect(cut.waiting).toEqual([]);
  expect(cut.problem).toBeNull();
  expect(deliverRows(cut).map((r) => [r.key, r.mark])).toEqual([["aspect", "ok"], ["fps", "ok"], ["duration", "none"], ["loudness", "none"]]);
  expect(cutMeta(cut)).toBe("3 approved takes · 0:15");
});

test("a clip is named by the version only once a shot has more than one, and a clip that is not a shot's take keeps its own name", () => {
  const lib = entries([gen({ id: "g1", shotId: "s1", version: 1 }), gen({ id: "g1b", shotId: "s1", version: 2, reviewState: "approved" }), gen({ id: "x1", shotId: null })]);
  const p = project({ assets: [clipAsset("a1", "g1b"), clipAsset("a2", "x1", "Loose clip")], shots: [
    { id: "c1", name: "A", assetId: "a1", duration: 120, sourceIn: 0, note: "" }, { id: "c2", name: "B", assetId: "a2", duration: 48, sourceIn: 0, note: "" },
  ] });
  const cut = cutOf(p, shotTakes(p, lib), lib);
  expect(cut.clips.map((c) => c.label)).toEqual(["Shot 1 · v2", "Loose clip"]);
  expect(cut.clips[1].seconds).toBe(2);
  expect(cut.clips[1].approved).toBe(false);
});

test("an empty cut says so, and the region draws nothing until there is a shot or a clip", () => {
  const bare = project({ nodes: [], shotMappings: {}, production: undefined });
  expect(deriveCut({ kind: "studio", project: bare, library: [] })).toEqual([]);
  const cut = cutOf(bare, [], []);
  expect(cut.problem).toBe("Add takes to the cut first.");
  expect(cut.complete).toBe(false);
  expect(deliverRows(cut)[2]).toMatchObject({ value: "00:00", mark: "pending" });
  expect(sequenceProblem(bare)).toMatch(/Add a shot/);
});

test("the Cut and Deliver cards sit in one group, the group says the cut's meta, and a guest-only kind draws nothing", () => {
  const p = project(sequence(["g1", "g2"]));
  const all = deriveCut({ kind: "studio", project: p, library: library() });
  expect(all.map((c) => [c.id, c.kind, c.region])).toEqual([["group:cut", "group", "cut"], ["cut:the-cut", "cut", "cut"], ["deliver:master", "deliver", "deliver"]]);
  expect(all[0].data).toMatchObject({ title: "Cut and deliver", meta: "2 approved takes · 0:10" });
  expect(all.slice(1).every((c) => c.group === "group:cut")).toBe(true);
  expect((all[1].data as CutCardData).cut.approved).toBe(2);
  expect(all[1].state).toBe("working");
  expect(deriveCut({ kind: "ads", project: p, library: library() })).toEqual([]);
});

test("a frame rate the EDL cannot carry fails once the cut is complete; runtime is mm:ss", () => {
  expect(specRows({ aspect: "9:16", fps: 60, seconds: 61, complete: true, empty: false })[1]).toMatchObject({ mark: "fail", word: "not a delivery rate" });
  expect(specRows({ aspect: "9:16", fps: 30, seconds: 61, complete: true, empty: false })[2].value).toBe("01:01");
  expect(runtime(0)).toBe("00:00");
});
