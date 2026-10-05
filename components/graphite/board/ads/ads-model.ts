import type { BoardCard, BoardSource, CardState, GroupData } from "@/lib/board/types";
import { OWN_LIMITS, brandKitMade, briefHooks } from "@/lib/shell/business-own";
import { hostOf } from "./reads";
import type { AdsExtra } from "./ads-session";
import { CREATIVE_CATEGORIES, CREATIVE_TEMPLATES, creativeTemplate, type BrandKit } from "@/lib/workbench/moleculr-creative";
import type { MoleculrBrief } from "@/lib/workbench/moleculr";
import { referenceAdOriginals, resolveReferenceAd } from "@/lib/workbench/reference-ad";
import type { Asset, Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { brandReview } from "./reads";
import { entryAsset } from "@/lib/production/sequence";
import { libraryIdOf } from "@/lib/shell/business-own";
import type { AdStill } from "@/lib/shell/business";

/*
 * The Ads board's cards, derived from the project draft's Business brief (`project.moleculr`), the project's own
 * Library takes and this tab's pending reads (lib/board/types BoardSource.extra). Pure and cheap. The master's
 * frames (README § 3.3, "Ads and Social frames"): frame 1 is the group "Brand, product and reference", frame 2
 * "Hooks and formats" and "Ads". Nothing here is a sample: a figure or a name that the project does not hold is not
 * drawn, and a section whose engine does not exist reads "Not in Particl yet" with no price.
 */

export const ADS_GROUP = { start: "group:ads-start", hooks: "group:ads-hooks", ads: "group:ads-ads", adapt: "group:ads-adapt", deliver: "group:ads-deliver" } as const;

/** The design's card width, and the Hooks and Format briefs cards' (the master: 308, 480 and 456; the group packs one column width). */
export const CARD_W = 308;
export const WIDE_W = 456;
export const SIZES = {
  brand: { w: CARD_W, h: 392 },
  product: { w: CARD_W, h: 392 },
  reference: { w: CARD_W, h: 392 },
  hooks: { w: WIDE_W, h: 400 },
  formats: { w: WIDE_W, h: 400 },
  imageAd: { w: CARD_W, h: 452 },
  result: { w: CARD_W, h: 372 },
  unavailable: { w: CARD_W, h: 92 },
} as const;

/* ── Card data (plain, no functions) ───────────────────────────────────── */

export type Phase = "none" | "reading" | "failed" | "review" | "made";
export type Row = { label: string; value: string; mono?: boolean };

export type BrandData = {
  phase: Phase; error: string | null; name: string; host: string; written: boolean;
  colors: string[]; typefaces: string; tone: string; logoUrl: string | null; website: string;
};
export type ProductData = {
  phase: Phase; error: string | null; name: string; brand: string; facts: string; imageUrl: string | null; images: number; host: string; written: boolean; saved: boolean; url: string;
};
export type ReferenceData = {
  phase: "none" | "chosen" | "running" | "review" | "done"; name: string; videoUrl: string | null; rows: Row[]; videos: number; reviewable: boolean;
};
export type HooksData = { lines: string[]; picked: string[]; room: number; writing: boolean; proposed: string[]; agentReady: boolean; agentConfigured: boolean; agentError: string | null };
export type FormatsData = { formats: { id: string; label: string; briefs: { id: string; name: string; kind: "image" | "video"; aspect: string }[] }[]; chosen: string | null; kind: "image" | "video" };
export type ImageAdData = { productName: string; stillUrl: string | null; stillName: string | null; still: AdStill | null; hasProduct: boolean; hook: string | null; defaultPrompt: string; productionId: string | null };
export type ResultData = {
  id: string; sourceId: string; name: string; tag: "IMAGE AD" | "VIDEO AD"; media: "image" | "video"; url: string | null; engine: string; credits: number | null;
  status: string; review: "" | "approved" | "picked" | "changes"; failure: string | null; at: number; asset: Asset;
};
export type UnavailableData = { title: string; line: string };

/* ── The brief, as the cards read it ───────────────────────────────────── */

const oneLine = (value: string | undefined, max = 120) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const firstLine = (value: string | undefined, max = 90) => oneLine((value ?? "").split(/\n/).find((l) => l.trim()) ?? "", max);

/** Whether the brief holds anything at all: an empty Ads board is the start card (G1), not four empty cards. */
export function briefStarted(brief: MoleculrBrief | undefined, extra: AdsExtra | null): boolean {
  if (extra?.brand || extra?.product) return true;
  if (!brief) return false;
  return Boolean(
    brief.brandKit?.website?.trim() || brandKitMade(brief.brandKit) || brief.productName.trim() || brief.productUrl.trim() || brief.productDescription?.trim()
    || brief.productAssetIds.length || brief.hooks.length || brief.referenceAd?.assetId || brief.products?.length || brief.poster || brief.creative?.templateId,
  );
}

const picture = (project: Pick<Project, "assets">, id: string | undefined): Asset | undefined => (id ? project.assets.find((a) => a.id === id && a.kind === "image") : undefined);

function brandCard(src: BoardSource, extra: AdsExtra | null): { data: BrandData; state: CardState; summary: string; needs?: number } {
  const brief = src.project.moleculr;
  const kit: BrandKit | undefined = brief?.brandKit;
  const made = brandKitMade(kit);
  /* A read whose values are on the kit already (approved here, or applied in the Edit panel) is no longer waiting. */
  const raw = extra?.brand ?? null;
  const read = raw?.status === "ready" && raw.result && kit?.source?.url === raw.result.source.finalUrl ? null : raw;
  const logo = picture(src.project, kit?.logoAssetId);
  const base = { error: null as string | null, logoUrl: logo?.url ?? null, website: kit?.website ?? read?.url ?? "" };
  if (read?.status === "ready" && read.result) {
    const r = brandReview(read.result);
    const data: BrandData = { ...base, phase: "review", name: r.name, host: hostOf(read.result.source.finalUrl), written: false, colors: r.colors, typefaces: r.fontFamilies.join(" · "), tone: firstLine(r.tone || r.tagline, 80) };
    return { data, state: "needs", summary: "Brand kit waiting for your review" };
  }
  if (read?.status === "reading") return { data: { ...base, phase: "reading", name: "", host: hostOf(read.url), written: false, colors: [], typefaces: "", tone: "" }, state: "working", summary: "Reading the brand's site" };
  if (read?.status === "failed" && !made) return { data: { ...base, error: read.error ?? "The site could not be read.", phase: "failed", name: "", host: hostOf(read.url), written: false, colors: [], typefaces: "", tone: "" }, state: "needs", summary: "The brand's site could not be read" };
  if (made && kit) {
    const data: BrandData = {
      ...base, phase: "made", name: oneLine(kit.name, 80), host: hostOf(kit.source?.url), written: !kit.source, colors: kit.colors.slice(0, OWN_LIMITS.colors),
      typefaces: (kit.fontFamilies?.length ? kit.fontFamilies : [kit.font === "geometric" ? "Geometric" : kit.font === "editorial" ? "Editorial" : "System"]).join(" · "), tone: firstLine(kit.voice || kit.tagline, 80),
    };
    return { data, state: "done", summary: `${data.name || "Brand kit"} · ${data.colors.length} colours` };
  }
  return { data: { ...base, phase: "none", name: "", host: "", written: false, colors: [], typefaces: "", tone: "" }, state: "empty", summary: "No brand kit yet" };
}

function productCard(src: BoardSource, extra: AdsExtra | null): { data: ProductData; state: CardState; summary: string } {
  const brief = src.project.moleculr;
  const rawRead = extra?.product ?? null;
  const read = rawRead?.status === "ready" && rawRead.result && brief?.productSource?.url === rawRead.result.source.finalUrl ? null : rawRead;
  const hasProduct = Boolean(brief && (brief.productName.trim() || brief.productDescription?.trim() || brief.productAssetIds.length));
  const image = picture(src.project, brief?.productAssetIds[0]);
  const blank = { error: null as string | null, brand: "", facts: "", imageUrl: null as string | null, images: 0, host: "", written: false, saved: false, url: brief?.productUrl ?? read?.url ?? "" };
  if (read?.status === "ready" && read.result) {
    const p = read.result.product;
    return { data: { ...blank, phase: "review", name: oneLine(p.name, 80), brand: oneLine(p.brand, 60), facts: firstLine(p.description), host: hostOf(read.result.source.finalUrl), images: 0 }, state: "needs", summary: "Product facts waiting for your review" };
  }
  if (read?.status === "reading") return { data: { ...blank, phase: "reading", name: "", host: hostOf(read.url) }, state: "working", summary: "Reading the product page" };
  if (read?.status === "failed" && !hasProduct) return { data: { ...blank, phase: "failed", error: read.error ?? "The page could not be read.", name: "", host: hostOf(read.url) }, state: "needs", summary: "The product page could not be read" };
  if (hasProduct && brief) {
    const data: ProductData = {
      phase: "made", error: null, name: oneLine(brief.productName, 80) || "Untitled product", brand: oneLine(brief.productBrand, 60), facts: firstLine(brief.productDescription), imageUrl: image?.url ?? null,
      images: brief.productAssetIds.length, host: hostOf(brief.productSource?.url ?? brief.productUrl), written: !brief.productSource, saved: Boolean(brief.activeProductId), url: brief.productUrl,
    };
    return { data, state: "done", summary: `${data.name}${data.images ? ` · ${data.images} of ${OWN_LIMITS.productImages} images` : ""}` };
  }
  return { data: { ...blank, phase: "none", name: "" }, state: "empty", summary: "No product yet" };
}

const beatTime = (seconds: number | undefined) => (typeof seconds === "number" ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "");

function referenceCard(src: BoardSource, extra: AdsExtra | null): { data: ReferenceData; state: CardState; summary: string } {
  const brief = src.project.moleculr;
  const value = brief?.referenceAd;
  const originals = referenceAdOriginals(src.project);
  const chosen = value?.assetId ? resolveReferenceAd(src.project, value) : null;
  const agent = extra?.agent ?? null;
  const applied = value?.analysis ?? null;
  const fresh = agent?.analysis && agent.analysis.evidence.source.assetId === value?.assetId && agent.analysis.jobId !== applied?.jobId ? agent.analysis : null;
  const shown = fresh ?? applied;
  if (!chosen) return { data: { phase: "none", name: "", videoUrl: null, rows: [], videos: originals.length, reviewable: false }, state: "empty", summary: "No reference ad yet" };
  const rows: Row[] = shown
    ? shown.result.beats.slice(0, 4).map((b) => ({ label: oneLine(b.observation, 36), value: beatTime(shown.evidence.samples[b.sampleIndex]?.timeSeconds), mono: true }))
    : [{ label: "Notes", value: firstLine(value?.notes, 40) || "None yet" }, { label: "Direction", value: firstLine(value?.direction, 40) || "None yet" }];
  const phase = agent?.referenceRunning ? "running" : fresh ? "review" : applied ? "done" : "chosen";
  const state: CardState = phase === "running" ? "working" : phase === "review" ? "needs" : "done";
  const summary = phase === "running" ? "Reviewing the reference ad" : phase === "review" ? "Reference review waiting for you" : phase === "done" ? "Reference reviewed and applied" : `Reference · ${oneLine(chosen.asset.name, 40)}`;
  return { data: { phase, name: oneLine(chosen.asset.name, 60), videoUrl: chosen.original.url, rows, videos: originals.length, reviewable: true }, state, summary };
}

/** The hooks the agent proposed that are not on the list yet. */
export function freshHooks(brief: Pick<MoleculrBrief, "hooks"> | undefined, proposed: readonly string[]): string[] {
  const have = new Set(briefHooks({ hooks: brief?.hooks ?? [] }).map((h) => h.toLowerCase()));
  const seen = new Set<string>();
  return proposed.map((h) => h.replace(/\s+/g, " ").trim()).filter((h) => h && !have.has(h.toLowerCase()) && !seen.has(h.toLowerCase()) && (seen.add(h.toLowerCase()), true));
}

function hooksCard(src: BoardSource, extra: AdsExtra | null): { data: HooksData; state: CardState; summary: string; needs?: number } {
  const brief = src.project.moleculr;
  const lines = briefHooks({ hooks: brief?.hooks ?? [] });
  const agent = extra?.agent ?? null;
  const proposed = freshHooks(brief, agent?.proposed ?? []);
  const data: HooksData = {
    lines, picked: [...(extra?.picked ?? [])].filter((h) => lines.includes(h)), room: Math.max(0, OWN_LIMITS.hooks - lines.length), writing: Boolean(agent?.hooksRunning), proposed,
    agentReady: Boolean(agent?.ready), agentConfigured: Boolean(agent?.configured), agentError: agent?.error ?? null,
  };
  if (data.writing) return { data, state: "working", summary: "The Campaign agent is writing hooks" };
  if (proposed.length) return { data, state: "needs", needs: proposed.length, summary: `${proposed.length} proposed ${proposed.length === 1 ? "line" : "lines"} to add` };
  if (lines.length) return { data, state: "done", summary: `${lines.length} ${lines.length === 1 ? "line" : "lines"}` };
  return { data, state: "empty", summary: "No hooks yet" };
}

function formatsCard(src: BoardSource): { data: FormatsData; state: CardState; summary: string } {
  const brief = src.project.moleculr;
  const template = brief ? creativeTemplate(brief) : undefined;
  const direction = (brief?.creative?.direction ?? "").trim();
  const data: FormatsData = {
    formats: CREATIVE_CATEGORIES.map((c) => ({ id: c.id, label: c.label, briefs: CREATIVE_TEMPLATES.filter((t) => t.category === c.id).map((t) => ({ id: t.id, name: t.name, kind: t.kind, aspect: t.aspect })) })),
    chosen: template?.id ?? null, kind: template?.kind ?? brief?.creative?.kind ?? "image",
  };
  if (template) return { data, state: "done", summary: `${template.name} · ${template.kind === "video" ? "video" : "image"}` };
  if (direction && brief?.creative?.path === "prompt") return { data, state: "done", summary: "Your own direction" };
  return { data, state: "empty", summary: `${CREATIVE_CATEGORIES.length} formats · ${CREATIVE_TEMPLATES.length} briefs` };
}

/** This project's own generations as results: images and videos only, newest first (the Library's order). Uploads are left out. */
export function adResults(library: readonly LibraryEntry[]): ResultData[] {
  return library.flatMap((entry): ResultData[] => {
    if (entry.asset.origin !== "generation" || (entry.media !== "image" && entry.media !== "video")) return [];
    const g = entry.asset.value;
    const t = entry.take;
    return [{
      id: t.id, sourceId: t.sourceId, name: t.name, tag: entry.media === "video" ? "VIDEO AD" : "IMAGE AD", media: entry.media, url: entry.url, engine: t.meta, credits: t.credits,
      status: t.status, review: g.reviewState, failure: t.status === "failed" ? t.failureLine ?? t.reason ?? "It failed." : null, at: t.createdAt, asset: entryAsset(entry),
    }];
  });
}
const IN_FLIGHT = new Set(["rendering", "held"]);
export const RESULTS_SHOWN = 11;

/** A short default prompt for the image-ad card, from the product, the picked hook and the brand's palette: editable on the card. */
export function defaultAdPrompt(brief: MoleculrBrief | undefined, hook: string | null): string {
  const product = oneLine(brief?.productName, 120) || "the product";
  const kit = brief && brandKitMade(brief.brandKit) ? brief.brandKit : null;
  return [
    `A polished advertising still of ${product}${brief?.productBrand?.trim() ? ` by ${oneLine(brief.productBrand, 80)}` : ""}.`,
    hook ? `Campaign line: ${hook}` : "",
    kit?.colors.length ? `Palette: ${kit.colors.slice(0, 4).join(", ")}.` : "",
    "Keep the product exactly as in the reference, with clean studio light and room for a headline.",
  ].filter(Boolean).join(" ");
}

function group(id: string, region: BoardCard["region"], title: string, meta: string, columns: number, order: number, tone?: "warning"): BoardCard<GroupData> {
  return { id, kind: "group", region, order, state: "empty", data: { title, meta, columns, ...(tone ? { tone } : {}) } };
}

/** The Ads board's cards (every card set's derive). Empty until the brief holds something: the board then shows its start card. */
export function adsCards(src: BoardSource): BoardCard[] {
  const extra = (src.extra as AdsExtra | null | undefined) ?? null;
  const brief = src.project.moleculr;
  const results = adResults(src.library);
  if (!briefStarted(brief, extra) && !results.length) return [];

  const brand = brandCard(src, extra), product = productCard(src, extra), reference = referenceCard(src, extra);
  const hooks = hooksCard(src, extra), formats = formatsCard(src);
  const waiting = [brand.state, product.state, reference.state].includes("needs");
  const cards: BoardCard[] = [
    group(ADS_GROUP.start, "brand", "Brand, product and reference", waiting ? "waiting for your review" : [brand.state, product.state].every((state) => state === "done") ? "approved" : "ready for your details", 3, 0),
    { id: "ads:brand", kind: "ads-brand", region: "brand", order: 1, group: ADS_GROUP.start, state: brand.state, summary: brand.summary, data: brand.data },
    { id: "ads:product", kind: "ads-product", region: "product", order: 2, group: ADS_GROUP.start, state: product.state, summary: product.summary, data: product.data },
    { id: "ads:reference", kind: "ads-reference", region: "product", order: 3, group: ADS_GROUP.start, state: reference.state, summary: reference.summary, data: reference.data },
    group(ADS_GROUP.hooks, "hooks", "Hooks and formats", "written against the brief", 2, 10),
    { id: "ads:hooks", kind: "ads-hooks", region: "hooks", order: 11, group: ADS_GROUP.hooks, state: hooks.state, ...(hooks.needs ? { needs: hooks.needs } : {}), summary: hooks.summary, data: hooks.data },
    { id: "ads:formats", kind: "ads-formats", region: "formats", order: 12, group: ADS_GROUP.hooks, state: formats.state, summary: formats.summary, data: formats.data },
  ];

  const images = results.filter((r) => r.media === "image").length, videos = results.length - images;
  const unjudged = results.filter((r) => r.status !== "failed" && !IN_FLIGHT.has(r.status) && r.review === "").length;
  const working = results.some((r) => IN_FLIGHT.has(r.status));
  cards.push(group(ADS_GROUP.ads, "ads", "Ads", results.length ? `${images} image · ${videos} video` : "image ads, made on the board or in Make", 3, 20));
  const still = picture(src.project, brief?.productAssetIds[0]);
  const stillId = still ? libraryIdOf(still) : null;
  const imageAd: ImageAdData = {
    productName: oneLine(brief?.productName, 80), hasProduct: Boolean(brief?.productName.trim()),
    stillUrl: still?.url ?? null, stillName: still?.name ?? null,
    still: still && stillId ? { id: stillId, name: still.name.slice(0, 300), sourceId: stillId.split(":")[1], origin: stillId.startsWith("generation:") ? "generation" : "upload", url: still.url } : null,
    hook: extra?.picked[0] ?? null, defaultPrompt: defaultAdPrompt(brief, extra?.picked[0] ?? null), productionId: src.project.productionProjectId ?? null,
  };
  cards.push({ id: "ads:image-ad", kind: "ads-image", region: "ads", order: 21, group: ADS_GROUP.ads, state: working ? "working" : unjudged ? "needs" : results.length ? "done" : "empty", ...(unjudged ? { needs: unjudged } : {}), summary: unjudged ? `${unjudged} ${unjudged === 1 ? "ad" : "ads"} to judge` : working ? "An ad is rendering" : results.length ? `${results.length} ${results.length === 1 ? "ad" : "ads"}` : "No ads yet", data: imageAd });
  results.slice(0, RESULTS_SHOWN).forEach((r, i) => cards.push({
    id: `ads:result:${r.id}`, kind: "ads-result", region: "ads", order: 30 + i, group: ADS_GROUP.ads, state: "empty", data: r,
  }));
  cards.push({ id: "ads:ugc", kind: "ads-unavailable", region: "ads", order: 99, group: ADS_GROUP.ads, state: "empty", data: { title: "UGC with consent", line: "Not in Particl yet" } satisfies UnavailableData });
  cards.push(group(ADS_GROUP.adapt, "adapt", "Adapt", "every size and language", 1, 40));
  cards.push({ id: "ads:adapt", kind: "ads-unavailable", region: "adapt", order: 41, group: ADS_GROUP.adapt, state: "empty", summary: "Not in Particl yet", data: { title: "Adapt", line: "Not in Particl yet" } satisfies UnavailableData });
  cards.push(group(ADS_GROUP.deliver, "deliver", "Deliver", "specs and export", 1, 50));
  cards.push({ id: "ads:deliver", kind: "ads-unavailable", region: "deliver", order: 51, group: ADS_GROUP.deliver, state: "empty", summary: "Not in Particl yet", data: { title: "Deliver", line: "Not in Particl yet" } satisfies UnavailableData });
  return cards;
}
