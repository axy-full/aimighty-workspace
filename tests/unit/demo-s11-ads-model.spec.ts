import { test, expect } from "@playwright/test";
import { adsCards, adResults, briefStarted, defaultAdPrompt, freshHooks, ADS_GROUP } from "../../components/graphite/board/ads/ads-model";
import { EMPTY_EXTRA, type AdsExtra } from "../../components/graphite/board/ads/ads-session";
import { buildRegistry } from "../../components/graphite/board/cards";
import { adsBoard } from "../../components/graphite/board/ads";
import { placeBoard } from "../../components/graphite/board/layout-cards";
import { railStatus } from "../../lib/board/regions";
import type { BoardSource } from "../../lib/board/types";
import { EMPTY_MOLECULR, type MoleculrBrief } from "../../lib/workbench/moleculr";
import { EMPTY_BRAND_KIT } from "../../lib/workbench/moleculr-creative";
import { newProject } from "../../lib/workbench/studio";
import type { LibraryEntry } from "../../lib/workspace/library";

/* Stream 11 · the Ads board's cards, derived from the brief, the Library and this tab's pending reads (neutral names only). */
const brief = (over: Partial<MoleculrBrief> = {}): MoleculrBrief => ({ ...EMPTY_MOLECULR, ...over });
const source = (moleculr: MoleculrBrief | undefined, extra: AdsExtra | null = null, library: LibraryEntry[] = []): BoardSource => ({
  kind: "ads", project: { ...newProject("Fixture"), ...(moleculr ? { moleculr } : {}) }, shots: [], jobs: [], library, masters: new Set(), extra, agent: null, now: 0,
});
const KIT = { ...EMPTY_BRAND_KIT, name: "Clear Co", tagline: "Water, simply.", voice: "Quiet.", colors: ["#0A84FF", "#F5F5F7"], source: { url: "https://clear.example.test/", reviewedAt: "2026-10-05T10:00:00.000Z" } };
const generation = (id: string, over: Record<string, unknown> = {}, media: "image" | "video" = "image"): LibraryEntry => ({
  take: { id: `generation:${id}`, sourceId: id, kind: "GEN", name: `Take ${id}`, version: "v1", meta: "2.0 · 1:1", credits: 4, usd: null, status: "review", sha256: null, createdAt: 10 },
  asset: { origin: "generation", value: { id, reviewState: "", model: "higgsfield/marketing-studio-image", kind: media, params: {}, status: "succeeded", createdAt: 10, ...over } as never },
  url: `/api/media/${id}`, media,
});

test("an empty brief draws nothing, so the board shows its start card", () => {
  expect(briefStarted(undefined, null)).toBe(false);
  expect(briefStarted(brief(), null)).toBe(false);
  expect(adsCards(source(undefined))).toEqual([]);
  expect(adsCards(source(brief()))).toEqual([]);
  /* An address the person typed, or a read in flight, is something to draw. */
  expect(briefStarted(brief({ productUrl: "https://shop.example.test/x" }), null)).toBe(true);
  expect(briefStarted(brief(), { ...EMPTY_EXTRA, product: { url: "https://shop.example.test/x", status: "reading" } })).toBe(true);
});

test("a filled brief is three groups of cards plus what is not built, in the master's order", () => {
  const cards = adsCards(source(brief({ productName: "Glass bottle", hooks: ["One.", "Two."], brandKit: KIT })));
  expect(cards.map((c) => c.id)).toEqual([
    ADS_GROUP.start, "ads:brand", "ads:product", "ads:reference", ADS_GROUP.hooks, "ads:hooks", "ads:formats", ADS_GROUP.ads, "ads:image-ad", "ads:ugc",
    ADS_GROUP.adapt, "ads:adapt", ADS_GROUP.deliver, "ads:deliver",
  ]);
  const by = new Map(cards.map((c) => [c.id, c]));
  expect(by.get("ads:brand")!.state).toBe("done");
  expect(by.get("ads:product")!.state).toBe("done");
  expect(by.get("ads:reference")!.state).toBe("empty");
  expect(by.get("ads:hooks")!.summary).toBe("2 lines");
  expect(by.get("ads:formats")!.summary).toBe("6 formats · 18 briefs");
  /* Adapt, Deliver and UGC with consent are not built: no price, no sample. */
  for (const id of ["ads:adapt", "ads:deliver", "ads:ugc"]) expect(JSON.stringify(by.get(id)!.data)).toContain("Not in Particl yet");
  expect(JSON.stringify(cards)).not.toMatch(/\bcr\b|\$/);
});

test("a read waits for review as needs; approved or applied, it is done; a failed read says so", () => {
  const read = (status: "reading" | "ready" | "failed", result?: unknown, error?: string): AdsExtra => ({
    ...EMPTY_EXTRA,
    brand: { url: "https://clear.example.test/", status, ...(result ? { result } : {}), ...(error ? { error } : {}) } as never,
    product: { url: "https://shop.example.test/x", status: "reading" },
  });
  const ready = { source: { requestedUrl: "https://clear.example.test/", finalUrl: "https://clear.example.test/", fetchedAt: "2026-10-05T10:00:00.000Z" }, brand: { name: "Clear Co", description: "", colors: ["#0A84FF"], fontFamilies: ["Inter"] } };
  const waiting = adsCards(source(brief({ brandKit: { ...EMPTY_BRAND_KIT, website: "https://clear.example.test/" } }), read("ready", ready)));
  const brand = waiting.find((c) => c.id === "ads:brand")!;
  expect(brand.state).toBe("needs");
  expect((brand.data as { phase: string; name: string }).phase).toBe("review");
  expect(waiting.find((c) => c.id === ADS_GROUP.start)!.data).toMatchObject({ meta: "waiting for your review" });
  /* The kit already carries this read's source: it was applied (here or in the Edit panel), so nothing waits. */
  const applied = adsCards(source(brief({ brandKit: { ...KIT, source: { url: ready.source.finalUrl, reviewedAt: "2026-10-05T10:00:00.000Z" } } }), read("ready", ready)));
  expect(applied.find((c) => c.id === "ads:brand")!.state).toBe("done");
  const failed = adsCards(source(brief({ productUrl: "https://shop.example.test/x" }), read("failed", undefined, "The site could not be read.")));
  expect(failed.find((c) => c.id === "ads:brand")).toMatchObject({ state: "needs", data: { phase: "failed", error: "The site could not be read." } });
  expect(failed.find((c) => c.id === "ads:product")).toMatchObject({ state: "working", data: { phase: "reading" } });
});

test("hooks: the agent's lines that are not on the list yet are what waits, and they count towards the rail", () => {
  expect(freshHooks({ hooks: ["Water, simply.", "  "] }, ["water, simply.", "New one.", "New one.", " Another "])).toEqual(["New one.", "Another"]);
  const agent = { ready: true, configured: true, hooksRunning: false, referenceRunning: false, proposed: ["One.", "Fresh line."], analysis: null, error: null };
  const cards = adsCards(source(brief({ hooks: ["One."] }), { ...EMPTY_EXTRA, agent }));
  const hooks = cards.find((c) => c.id === "ads:hooks")!;
  expect(hooks).toMatchObject({ state: "needs", needs: 1, data: { proposed: ["Fresh line."], room: 11 } });
  expect(cards.find((c) => c.id === "ads:hooks")!.summary).toBe("1 proposed line to add");
  const running = adsCards(source(brief({ hooks: ["One."] }), { ...EMPTY_EXTRA, agent: { ...agent, hooksRunning: true } })).find((c) => c.id === "ads:hooks")!;
  expect(running.state).toBe("working");
  const full = adsCards(source(brief({ hooks: Array.from({ length: 12 }, (_, i) => `Line ${i}`) }))).find((c) => c.id === "ads:hooks")!;
  expect((full.data as { room: number }).room).toBe(0);
});

test("results are this project's generations, images and videos, newest first; uploads are left out", () => {
  const upload: LibraryEntry = { ...generation("u1"), asset: { origin: "upload", value: { id: "u1" } as never } };
  const results = adResults([generation("g1"), generation("g2", {}, "video"), upload]);
  expect(results.map((r) => [r.sourceId, r.tag])).toEqual([["g1", "IMAGE AD"], ["g2", "VIDEO AD"]]);
  expect(results[0]).toMatchObject({ credits: 4, review: "", engine: "2.0 · 1:1" });
  const cards = adsCards(source(brief({ productName: "Glass bottle" }), null, [generation("g1"), generation("g2", { reviewState: "approved" })]));
  const ads = cards.find((c) => c.id === ADS_GROUP.ads)!;
  expect(ads.data).toMatchObject({ meta: "2 image · 0 video" });
  /* One ad waits for a judgement; the rail says so. */
  expect(cards.find((c) => c.id === "ads:image-ad")).toMatchObject({ state: "needs", needs: 1, summary: "1 ad to judge" });
  expect(cards.filter((c) => c.kind === "ads-result").map((c) => c.id)).toEqual(["ads:result:generation:g1", "ads:result:generation:g2"]);
});

test("the cards lay out in the design's bands with the rail's own regions", () => {
  const src = source(brief({ productName: "Glass bottle", brandKit: KIT, hooks: ["One."] }));
  const registry = buildRegistry(adsBoard.sets);
  const placed = placeBoard(registry.derive(src), registry.defs, adsBoard.bands, "16:9");
  /* Every card kind has a definition, so none is dropped. */
  expect(placed.cards.length).toBe(adsCards(src).length);
  const box = (id: string) => placed.boxes.get(id)!;
  /* Frame 1: three cards side by side in one group; frame 2's group sits below it. */
  expect(box("ads:brand").y).toBe(box("ads:product").y);
  expect(box("ads:product").y).toBe(box("ads:reference").y);
  expect(box("ads:brand").x).toBeLessThan(box("ads:product").x);
  expect(box(ADS_GROUP.hooks).y).toBeGreaterThan(box(ADS_GROUP.start).y + box(ADS_GROUP.start).h);
  /* Adapt and Deliver sit side by side, last. */
  expect(box(ADS_GROUP.adapt).y).toBe(box(ADS_GROUP.deliver).y);
  expect(box(ADS_GROUP.adapt).y).toBeGreaterThan(box(ADS_GROUP.ads).y);
  const status = railStatus(adsBoard.rail, placed.cards);
  expect([...status.keys()]).toEqual(["brand", "product", "hooks", "formats", "ads", "adapt", "deliver"]);
  expect(status.get("brand")!.state).toBe("done");
  expect(status.get("adapt")).toMatchObject({ state: "empty", summary: "Not in Particl yet" });
  expect(status.get("deliver")!.summary).toBe("Not in Particl yet");
  /* No group is wider than the board's band. */
  for (const id of [ADS_GROUP.start, ADS_GROUP.hooks, ADS_GROUP.ads]) expect(box(id).w).toBeLessThanOrEqual(1008);
});

test("the image ad's starting words come from the product, the picked hook and the brand's palette", () => {
  expect(defaultAdPrompt(undefined, null)).toContain("the product");
  const text = defaultAdPrompt(brief({ productName: "Glass bottle", productBrand: "Clear Co", brandKit: KIT }), "Water, simply.");
  expect(text).toContain("Glass bottle by Clear Co");
  expect(text).toContain("Campaign line: Water, simply.");
  expect(text).toContain("#0A84FF");
});
