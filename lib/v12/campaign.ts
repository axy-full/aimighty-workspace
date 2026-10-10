/**
 * The Campaign board's stages in the new interface (docs/redesign/inventory.md § 10.1; prototype L582–L585): Product, Look,
 * Formats and Variants, as data. Pure: no React, no fetch (tests/unit/v12-campaign.spec.ts).
 *
 * Everything here reads what today's Ads board already holds (the brief's product and brand kit, lib/workbench/moleculr*.ts)
 * and what its reads return (lib/workbench/product-extraction-types.ts, brand-extraction-types.ts). A format is a creative
 * brief of today's catalogue (lib/workbench/moleculr-creative.ts › CREATIVE_TEMPLATES) that Make runs; one with no brief or
 * engine behind it is drawn and cannot be pressed, with its reason. Prices are the server's, asked at the settings Make opens
 * on (lib/shell/make-price.ts), or "quoted" where no quote path covers the run: no figure is written here.
 */
import type { BrandExtraction } from "@/lib/workbench/brand-extraction-types";
import type { ProductExtraction } from "@/lib/workbench/product-extraction-types";
import type { BrandKit, CreativeTemplate } from "@/lib/workbench/moleculr-creative";
import { CREATIVE_TEMPLATES } from "@/lib/workbench/moleculr-creative";
import { MAKE_MODEL_PREFERENCE, MAKE_PICKS } from "@/lib/shell/make-price";
import type { QuoteSource } from "./quote";
import type { UnpricedId } from "./unpriced";

/* ── Product ──────────────────────────────────────────────────────────── */

/** What the Product stage says of a read, for review before anything is used (prototype: Claims · Colours · Logo · Packshots). */
export type ProductReview = {
  name: string;
  brand: string;
  /** What the page says, cut at a word (never a claim the page did not make). */
  says: string;
  /** Hex colours with their names where the page gave one, from the brand read of the same site. */
  colours: string[];
  /** The logo candidates and the packshot candidates the page offers (addresses to import as originals, never generated). */
  logos: { url: string; alt: string }[];
  packshots: { url: string; alt: string }[];
  warnings: string[];
};

const words = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return `${(at > max / 2 ? head.slice(0, at) : t.slice(0, max)).replace(/[\s,;:·–—-]+$/u, "")}…`;
};
const HEX = /^#[0-9a-f]{6}$/i;

export function productReview(product: ProductExtraction, brand: BrandExtraction | null): ProductReview {
  return {
    name: words(product.product.name, 120), brand: words(product.product.brand, 80), says: words(product.product.description, 220),
    colours: (brand?.brand.colors ?? []).filter((c) => HEX.test(c)).map((c) => c.toUpperCase()).slice(0, 8),
    logos: (brand?.logoCandidates ?? []).slice(0, 4).map((c) => ({ url: c.url, alt: c.alt?.trim() || "Logo" })),
    packshots: product.imageCandidates.slice(0, 6).map((c, i) => ({ url: c.url, alt: c.alt?.trim() || `Packshot ${i + 1}` })),
    warnings: product.warnings.slice(0, 3).map((w) => words(w, 160)),
  };
}

/** The host of an address, or "". */
export const hostOfUrl = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

/* ── Look ─────────────────────────────────────────────────────────────── */

/**
 * The brand's mandatories as the brand kit can answer them (prototype: Logo, End packshot, Legal, Fonts, Colours, VO tagline).
 * The kit holds a logo, typefaces, colours and a tagline; the product holds its images. Nothing holds a legal line, so that
 * row is never ticked. `ok` is whether the row has what it needs.
 */
export type MandatoryRow = { label: string; value: string; ok: boolean };
export const LEGAL_WHY = "A legal line has no place to live in Particl yet.";
export function mandatories(kit: BrandKit | null, packshots: number): MandatoryRow[] {
  const fonts = kit?.fontFamilies?.length ? kit.fontFamilies.join(" · ") : "";
  const colours = kit?.colors?.length ? kit.colors.join(" · ") : "";
  return [
    { label: "Logo", ok: Boolean(kit?.logoAssetId), value: kit?.logoAssetId ? "Set on the brand kit" : "Not set" },
    { label: "End packshot", ok: packshots > 0, value: packshots > 0 ? `${packshots} real ${packshots === 1 ? "photo" : "photos"}` : "Not set" },
    { label: "Legal line", ok: false, value: "Not stored yet" },
    { label: "Fonts", ok: Boolean(fonts), value: fonts || "Not set" },
    { label: "Colours", ok: Boolean(colours), value: colours || "Not set" },
    { label: "VO tagline", ok: Boolean(kit?.tagline?.trim()), value: kit?.tagline?.trim() || "Not set" },
  ];
}

/* ── Formats ──────────────────────────────────────────────────────────── */

/** One skill card (prototype § 10.1): the eight formats, each a brief of today's catalogue or not built. */
export type CampaignFormat = {
  id: string;
  title: string;
  line: string;
  /** The catalogue brief Make runs for it, or null when none exists. */
  templateId: string | null;
  /** A real person's face on camera asks for a consent record. */
  person: boolean;
  /** Why it cannot be made at all today, or null. */
  notBuilt: string | null;
};

export const CAMPAIGN_FORMATS: readonly CampaignFormat[] = [
  { id: "product-video-ad", title: "Product video ad", line: "15 s · the product, its setting, the line", templateId: "motion-orbit", person: false, notBuilt: null },
  { id: "talking-review", title: "Talking review", line: "A person on camera · consent record", templateId: "ugc-presenter", person: true, notBuilt: null },
  { id: "unboxing", title: "Unboxing", line: "The pack opened, the product revealed", templateId: "ugc-silent", person: false, notBuilt: null },
  { id: "try-on", title: "Try-on", line: "The product on a person, in a still", templateId: "editorial-model", person: false, notBuilt: null },
  { id: "tutorial", title: "Tutorial", line: "Three steps to using it", templateId: "ugc-faceless", person: false, notBuilt: null },
  { id: "voice-over", title: "Product voice-over", line: "Narrated pack shots", templateId: null, person: false, notBuilt: "No brief or engine makes narrated pack shots yet." },
  { id: "walk-through", title: "Website walk-through", line: "Your page, narrated", templateId: null, person: false, notBuilt: "No brief or engine makes a narrated walk-through yet." },
  { id: "photoshoot", title: "Photoshoot", line: "Packshot · lifestyle · banner · carousel", templateId: "studio-seamless", person: false, notBuilt: null },
];

const APPAREL = /\b(shirt|t-?shirt|top|dress|skirt|jacket|coat|hoodie|sweater|jumper|trousers?|pants|jeans|shorts|suit|shoes?|sneakers?|boots?|sandals?|hat|cap|beanie|scarf|gloves?|socks?|watch|bag|backpack|purse|wallet|belt|glasses|sunglasses|jewel(?:l)?ery|ring|necklace|bracelet|earrings?|apparel|clothing|wear)\b/i;

/** Whether a format fits the product: only Try-on can say no, for something that is not worn, and never before a product is known. */
export function formatFits(format: CampaignFormat, product: { name: string; brand: string; description: string }): { fits: true } | { fits: false; why: string } {
  if (format.id !== "try-on") return { fits: true };
  const known = `${product.name} ${product.brand} ${product.description}`.trim();
  if (!product.name.trim() || APPAREL.test(known)) return { fits: true };
  return { fits: false, why: `Doesn’t apply: Try-on fits apparel and accessories, not ${words(product.name, 40)}.` };
}

export const templateOf = (format: CampaignFormat): CreativeTemplate | null => (format.templateId ? CREATIVE_TEMPLATES.find((t) => t.id === format.templateId) ?? null : null);

/**
 * The one price of a format's run, from the quote layer: a video format asks the engines route at Make's own defaults (the
 * engine Make opens on, 1080p, five seconds) at the brief's size: the figure Make's button will show. A still format is a
 * set of briefs priced in Make, and a format with nothing behind it has none: both read "quoted", each with its reason.
 */
export function formatQuote(format: CampaignFormat, ratio?: string): { source: QuoteSource } | { reason: UnpricedId } {
  const template = templateOf(format);
  if (!template) return { reason: "campaignFormatNotBuilt" };
  if (template.kind !== "video") return { reason: "campaignStills" };
  const first = MAKE_MODEL_PREFERENCE.video[0];
  if (typeof first !== "string") return { reason: "campaignStills" };
  return { source: { route: "engine", model: first, resolution: MAKE_PICKS.resolution ?? "1080p", ratio: ratio ?? template.aspect, duration: 5 } };
}

/* ── Variants ─────────────────────────────────────────────────────────── */

/** The grid's columns (prototype): the sizes a hook is made for. */
export const VARIANT_COLUMNS = [
  { id: "reels", label: "Reels 9:16", ratio: "9:16" },
  { id: "feed", label: "Feed 4:5", ratio: "4:5" },
  { id: "youtube", label: "YouTube 16:9", ratio: "16:9" },
] as const;
export const VARIANTS_NOTE = [
  ["Rows", "opening hooks · written against the brief"],
  ["Columns", "Reels 9:16 · Feed 4:5 · YouTube 16:9"],
] as const;
export const VERSIONS_WHY = "Versions of an approved ad (keeping its motion and cuts) aren’t built yet.";
export const FIRST_ROW_WHY = "Make runs one ad at a time today, so each cell is made in Make with its own price.";
