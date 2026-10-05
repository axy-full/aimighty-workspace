import { test, expect } from "@playwright/test";
import { shotTakes } from "../../components/graphite/board/cards/take/take-model";
import { advancedRows, downloadHref, editQuoteBody, paidCredits } from "../../components/graphite/board/inspector/inspector-model";
import { entries, gen, project } from "./demo-s05-fixtures";

/* Stream 5 · the Inspector on a take (design/particl-graphite/README.md § 3.1 k). */

test("what a take was charged is its ledger's billed figure, and nothing while it renders", () => {
  const [row] = shotTakes(project(), entries([gen({ shotId: "s1", creditsBilled: 43 })]));
  expect(paidCredits(row.shown!)).toBe(43);
  const [live] = shotTakes(project(), entries([gen({ shotId: "s1", status: "running", storedUrl: null, creditsBilled: null })]));
  expect(paidCredits(live.shown!)).toBeNull();
});

test("Advanced shows the settings the request carried, and only those", () => {
  const [row] = shotTakes(project(), entries([gen({ shotId: "s1", params: { duration: 5, resolution: "1080p", seed: 41822, generateAudio: true }, durationS: 5, authorName: "Person One" })]));
  expect(advancedRows(row.shown!)).toEqual([
    { k: "Seed", v: "41822" }, { k: "Resolution", v: "1080p" }, { k: "Length", v: "5 s" }, { k: "Audio", v: "on" }, { k: "Made by", v: "Person One" },
  ]);
  expect(downloadHref("g 1")).toBe("/api/media/g%201?download=1");
});

test("Change with words is quoted on a clip the way Seedance Edit's panel opens, and a still has no quote", () => {
  const [clip] = shotTakes(project(), entries([gen({ shotId: "s1", kind: "video", model: "dreamina-seedance-2-5-260628" })]));
  expect(editQuoteBody(clip.shown!, "prod-1")).toMatchObject({ projectId: "prod-1", task: "edit", model: "dreamina-seedance-2-5-260628", sourceGenId: clip.shown!.genId, resolution: "720p", generateAudio: true, refine: false });
  const [still] = shotTakes(project(), entries([gen({ shotId: "s1", kind: "image", model: "gemini-3-pro-image" })]));
  expect(editQuoteBody(still.shown!, "prod-1")).toBeNull();
});
