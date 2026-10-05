import { test, expect } from "@playwright/test";
import { shotTakes } from "../../components/graphite/board/cards/take/take-model";
import { advancedRows, downloadHref, paidCredits } from "../../components/graphite/board/inspector/inspector-model";
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
