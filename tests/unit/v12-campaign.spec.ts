import { test, expect } from "@playwright/test";
import { CAMPAIGN_FORMATS, formatFits, formatQuote, hostOfUrl, mandatories, productReview, templateOf } from "../../lib/v12/campaign";
import { stagePage, stagesOf } from "../../lib/v12/board/stages";
import { UNPRICED } from "../../lib/v12/unpriced";
import { CREATIVE_TEMPLATES } from "../../lib/workbench/moleculr-creative";

/**
 * The Campaign board's first stages in the new interface (lib/v12/campaign.ts; redesign P6-a): what a read says for review,
 * the brand's mandatories as the kit can answer them, the eight formats with one price each (the server's, or "quoted" with a
 * reason), and which stages are pages. Pure.
 */
const PRODUCT = {
  source: { requestedUrl: "https://shop.example.test/x", finalUrl: "https://shop.example.test/x", fetchedAt: "2026-10-10T00:00:00Z" },
  product: { name: "Linen bowl", description: "A hand-thrown bowl. ".repeat(40), brand: "Quay Ceramics" },
  evidence: [], warnings: ["One"], imageCandidates: Array.from({ length: 9 }, (_, i) => ({ url: `https://shop.example.test/${i}.png`, source: "json-ld" as const })),
};

test("a read is cut for review: words at a word, real packshots and logos, only hex colours", () => {
  const review = productReview(PRODUCT as never, { brand: { colors: ["#c8b6a0", "red", "#2F3A46"] }, logoCandidates: [{ url: "https://shop.example.test/l.png", alt: " " }] } as never);
  expect(review.says.length).toBeLessThanOrEqual(222);
  expect(review.says.endsWith("…")).toBe(true);
  expect(review.colours).toEqual(["#C8B6A0", "#2F3A46"]);
  expect(review.packshots).toHaveLength(6);
  expect(review.logos).toEqual([{ url: "https://shop.example.test/l.png", alt: "Logo" }]);
  expect(hostOfUrl("https://www.shop.example.test/a")).toBe("shop.example.test");
  expect(hostOfUrl("not a url")).toBe("");
});

test("the mandatories are ticked only for what the brand kit holds; a legal line never is", () => {
  const none = mandatories(null, 0);
  expect(none.map((r) => r.label)).toEqual(["Logo", "End packshot", "Legal line", "Fonts", "Colours", "VO tagline"]);
  expect(none.every((r) => !r.ok)).toBe(true);
  const kit = { logoAssetId: "a1", fontFamilies: ["Inter"], colors: ["#000000"], tagline: "Made by hand" } as never;
  expect(mandatories(kit, 2).filter((r) => r.ok).map((r) => r.label)).toEqual(["Logo", "End packshot", "Fonts", "Colours", "VO tagline"]);
});

test("eight formats: each a brief of today's catalogue or not built; Try-on says no to what is not worn", () => {
  expect(CAMPAIGN_FORMATS).toHaveLength(8);
  for (const f of CAMPAIGN_FORMATS) expect(f.templateId === null ? f.notBuilt : f.notBuilt ?? "ok").toBeTruthy();
  for (const f of CAMPAIGN_FORMATS) if (f.templateId) expect(templateOf(f), f.id).toBeTruthy();
  expect(CREATIVE_TEMPLATES.length).toBeGreaterThan(0);
  const tryOn = CAMPAIGN_FORMATS.find((f) => f.id === "try-on")!;
  expect(formatFits(tryOn, { name: "Linen bowl", brand: "", description: "" })).toMatchObject({ fits: false });
  expect(formatFits(tryOn, { name: "Cotton shirt", brand: "", description: "" })).toEqual({ fits: true });
  expect(formatFits(tryOn, { name: "", brand: "", description: "" })).toEqual({ fits: true });
  expect(formatFits(CAMPAIGN_FORMATS[0], { name: "Linen bowl", brand: "", description: "" })).toEqual({ fits: true });
});

test("a format's price is a quote request or a reason, never a figure written here", () => {
  const video = CAMPAIGN_FORMATS.find((f) => templateOf(f)?.kind === "video")!;
  const asked = formatQuote(video);
  expect("source" in asked).toBe(true);
  if ("source" in asked) expect(JSON.stringify(asked.source)).not.toMatch(/\bcr\b|credits/);
  const stills = CAMPAIGN_FORMATS.find((f) => templateOf(f) && templateOf(f)!.kind !== "video");
  if (stills) expect(formatQuote(stills)).toEqual({ reason: "campaignStills" });
  const unbuilt = CAMPAIGN_FORMATS.find((f) => !f.templateId)!;
  expect(formatQuote(unbuilt)).toEqual({ reason: "campaignFormatNotBuilt" });
  expect(UNPRICED.campaignStills.action).toContain("Campaign");
  expect(UNPRICED.campaignFormatNotBuilt.action).toContain("Campaign");
});

test("Product, Look and Formats are pages of a Campaign board; its other stages, and other kinds' stages of those names, keep their cards", () => {
  expect(["product", "look", "formats"].map((id) => stagePage(id, "campaign"))).toEqual(["product", "look", "formats"]);
  expect(stagePage("variants", "campaign")).toBeNull();
  expect(stagePage("deliver", "campaign")).toBeNull();
  expect(stagePage("product", "film")).toBeNull();
  expect(stagesOf("campaign", null).map((s) => s.id)).toEqual(["product", "look", "formats", "variants", "deliver"]);
});
