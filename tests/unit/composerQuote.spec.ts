import { test, expect } from "@playwright/test";
import { estimateComposerVideo } from "../../lib/composerQuote";
import { billCredits } from "../../lib/creditTerms";
import { MODELS } from "../../lib/models";
import { buildRateTable } from "../../lib/rateTable.server";
import { charged } from "../../lib/rateTable";
import { estimateCostUsd } from "../../lib/vendorPricing";

test("Gen quotes attached clip duration at the same rate and credit bound as submission", () => {
  const references = [
    { kind: "video", durationS: 8 },
    { kind: "image", durationS: null },
    { kind: "video", durationS: 6.5 },
  ];
  let comparisons = 0;
  for (const model of MODELS.filter(
    (m) => m.kind === "video" && m.durations.length,
  )) {
    const duration = model.durations[0];
    for (const resolution of model.resolutions) {
      for (const audio of [false, true]) {
        const actual = estimateCostUsd(
          model.id,
          resolution,
          "16:9",
          duration,
          14.5,
          true,
          {
            audio: audio && model.supportsAudio,
          },
        );
        if (actual == null) continue;
        const credits = buildRateTable("cr");
        const quote = estimateComposerVideo(
          credits,
          model.id,
          resolution,
          "16:9",
          duration,
          audio,
          references,
        );
        expect(charged(credits, quote)).toBe(billCredits(actual.net, model.id));
        const direct = estimateComposerVideo(
          buildRateTable("usd"),
          model.id,
          resolution,
          "16:9",
          duration,
          audio,
          references,
        );
        expect(direct).toBeCloseTo(actual.net, 6);
        comparisons++;
      }
    }
  }
  expect(comparisons).toBeGreaterThan(10);
});

test("a long reference changes the Gen quote, and unknown durations cannot produce a false bound", () => {
  const rates = buildRateTable("cr");
  const model = "dreamina-seedance-2-5-260628";
  const quote = (references: { kind: string; durationS: number | null }[]) =>
    estimateComposerVideo(rates, model, "1080p", "16:9", 5, true, references);
  const without = quote([])!;
  expect(quote([{ kind: "image", durationS: null }])).toBe(without);
  expect(quote([{ kind: "video", durationS: 15 }])).toBeGreaterThan(without);
  for (const durationS of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(quote([{ kind: "video", durationS }])).toBeNull();
  }
});
