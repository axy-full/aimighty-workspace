/**
 * Business › Particl's own tools, in the Suites shell for every workspace and
 * every member: the brand kit read from a website, product profiles, the
 * eighteen creative briefs, the hooks writer, the reference-ad review and the
 * poster designer. None of them needs a connected account. Everything they
 * make lives in the project's Business brief (`project.moleculr`,
 * lib/workbench/moleculr.ts), saved with the project draft.
 *
 * Pure: the pages, what the brief holds as setup items (the products, brand
 * kit and ad reference Particl made), the pickers' rules, the hooks list, and
 * the prompt a brief hands to Gen — which prices it on its button before
 * anything runs.
 */
import { MOLECULR_FORMATS, type MoleculrBrief } from "@/lib/workbench/moleculr";
import { CREATIVE_TEMPLATES, creativeTemplate, switchProduct, type BrandKit, type CreativeTemplate, type ProductProfile } from "@/lib/workbench/moleculr-creative";
import { referenceAdDirection, resolveReferenceAd } from "@/lib/workbench/reference-ad";
import type { Asset, Project } from "@/lib/workbench/studio";
import type { SetupItem, SetupType } from "./business";

/* ── Pages ───────────────────────────────────────────────────────────── */

/** Business's own pages, in strip order after the account's (lib/shell/ia.ts). */
export const OWN_PAGES = ["brand", "product", "format", "hooks", "reference", "design"] as const;
export type OwnPage = (typeof OWN_PAGES)[number];
export const isOwnPage = (page: string | null | undefined): page is OwnPage => (OWN_PAGES as readonly string[]).includes(page ?? "");
/** What each page is called where another page points at it ("Open in Product"). */
export const OWN_PAGE_LABEL: Record<OwnPage, string> = { brand: "Brand", product: "Product", format: "Format", hooks: "Hooks", reference: "Reference", design: "Design" };

/* ── Money ───────────────────────────────────────────────────────────── */

/** A price shown before anything paid runs is an estimate: "about 7 cr", never an exact figure. */
export function aboutCredits(credits: number): string {
  const whole = Number.isFinite(credits) ? Math.max(0, Math.ceil(credits)) : 0;
  return `about ${whole.toLocaleString("en-US")} cr`;
}

/* ── Limits (lib/workbench/studio-schema.ts › moleculrSchema) ───────── */

export const OWN_LIMITS = { products: 24, productImages: 5, colors: 8, hooks: 12, hookChars: 500, fontFamilies: 8 } as const;

/* ── Setup items Particl made ───────────────────────────────────────── */

/**
 * Particl's own items carry this prefix. A connected account's setup ids are
 * its own UUIDs, and the account's quote guard (lib/higgsfield-consumer/
 * marketing-records.ts) refuses any id Particl did not record there, so one of
 * these can never be sent to the account as a product, brand kit or reference.
 */
export const PARTICL_SETUP_PREFIX = "particl-";
export type ParticlSetupType = Extract<SetupType, "product" | "brand_kit" | "ad_reference">;
export const PARTICL_SETUP_TYPES: readonly [ParticlSetupType, string][] = [["product", "Products"], ["brand_kit", "Brand kits"], ["ad_reference", "Ad references"]];
export type ParticlSetupItem = SetupItem & {
  type: ParticlSetupType;
  /** The brief's own id: a product profile's id, the project's for its brand kit, the reference video's asset id. */
  source: string;
  /** The page that makes and edits it. */
  open: OwnPage;
  /** The product the brief is on now, or the brand kit and reference every brief carries. */
  active: boolean;
};
export const isParticlSetupId = (id: string) => id.startsWith(PARTICL_SETUP_PREFIX);

const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120) || "item";
const oneLine = (value: string | undefined, max = 160) => (value ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
function hostOf(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A still's URL when it is one of this project's pictures, for a row's thumbnail. */
function pictureUrl(project: Pick<Project, "assets">, id: string | undefined): string | null {
  const asset = id ? project.assets.find((a) => a.id === id && a.kind === "image") : undefined;
  return asset?.url ?? null;
}

/** Whether a brand kit holds anything worth listing: a name, words, a logo, or a reviewed website. A typed address alone is not a kit yet. */
export function brandKitMade(kit: BrandKit | undefined): kit is BrandKit {
  if (!kit) return false;
  return Boolean(kit.name.trim() || kit.tagline.trim() || kit.voice.trim() || kit.audience.trim() || kit.description?.trim() || kit.logoAssetId || kit.source);
}

/**
 * The products, brand kit and ad reference Particl made in this project, as
 * setup items: what Business › Setup lists and the Format page's pickers
 * offer. A product is listed once it is saved as a profile; the brand kit
 * once it holds something; the reference once its video is still in the
 * project. Nothing is read from a connected account.
 */
export function particlSetupItems(project: Pick<Project, "id" | "assets" | "moleculr">): Record<ParticlSetupType, ParticlSetupItem[]> {
  const brief = project.moleculr;
  const out: Record<ParticlSetupType, ParticlSetupItem[]> = { product: [], brand_kit: [], ad_reference: [] };
  if (!brief) return out;
  const seen = new Set<string>();
  for (const profile of brief.products ?? []) {
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    const active = profile.id === brief.activeProductId;
    /* The active profile is edited on the brief itself; its images there are the current ones. */
    const images = active ? brief.productAssetIds : profile.assetIds;
    const host = hostOf(profile.source?.url);
    out.product.push({
      id: `${PARTICL_SETUP_PREFIX}product-${safeId(profile.id)}`, type: "product", source: profile.id, open: "product", active,
      name: oneLine(active ? brief.productName || profile.name : profile.name) || "Untitled product",
      meta: ["Made in Particl", plural(images.length, "image"), oneLine(profile.brand, 60), host ? `reviewed from ${host}` : ""].filter(Boolean).join(" · "),
      previewUrl: images.map((id) => pictureUrl(project, id)).find(Boolean) ?? null,
    });
  }
  if (brandKitMade(brief.brandKit)) {
    const kit = brief.brandKit;
    const host = hostOf(kit.source?.url ?? kit.website);
    out.brand_kit.push({
      id: `${PARTICL_SETUP_PREFIX}brand-${safeId(project.id)}`, type: "brand_kit", source: project.id, open: "brand", active: true,
      name: oneLine(kit.name) || "Brand kit",
      meta: ["Made in Particl", plural(kit.colors.length, "colour"), kit.logoAssetId ? "logo" : "", host ? `from ${host}` : ""].filter(Boolean).join(" · "),
      previewUrl: pictureUrl(project, kit.logoAssetId),
    });
  }
  const reference = brief.referenceAd;
  const original = reference?.assetId ? resolveReferenceAd(project, reference) : null;
  if (reference && original) {
    out.ad_reference.push({
      id: `${PARTICL_SETUP_PREFIX}reference-${safeId(original.asset.id)}`, type: "ad_reference", source: original.asset.id, open: "reference", active: true,
      name: oneLine(original.asset.name) || "Reference ad",
      meta: ["Made in Particl", "video", reference.analysis ? "reviewed" : "", reference.direction.trim() ? "direction set" : ""].filter(Boolean).join(" · "),
      previewUrl: null,
    });
  }
  return out;
}
/** Every Particl item, in Setup's order. */
export const particlSetupList = (project: Pick<Project, "id" | "assets" | "moleculr">): ParticlSetupItem[] => {
  const items = particlSetupItems(project);
  return PARTICL_SETUP_TYPES.flatMap(([type]) => items[type]);
};

/** What a Particl item's detail offers: the page that edits it, and where it can be used. */
export function particlItemActions(item: Pick<ParticlSetupItem, "type" | "active">): { open: OwnPage; use: OwnPage[] } {
  if (item.type === "product") return { open: "product", use: ["format"] };
  if (item.type === "brand_kit") return { open: "brand", use: ["format", "design"] };
  return { open: "reference", use: ["format"] };
}

/* ── Pickers ─────────────────────────────────────────────────────────── */

/** An unsaved product on the brief: words or images, but no profile yet. Switching away from it would lose it. */
export function unsavedProduct(brief: MoleculrBrief): boolean {
  return !brief.activeProductId && Boolean(brief.productName.trim() || brief.productUrl.trim() || brief.productDescription?.trim() || brief.productBrand?.trim() || brief.productAssetIds.length);
}

/**
 * The product picker (Format, Setup › Use in Format): a saved profile becomes
 * the product the brief is about — its facts and images ride with every
 * brief. The profile being edited is kept first; a product not yet saved as
 * a profile is never thrown away to make room.
 */
export function chooseProduct(brief: MoleculrBrief, productId: string): { brief: MoleculrBrief; problem: null } | { brief: null; problem: string } {
  if (brief.activeProductId === productId) return { brief, problem: null };
  if (!(brief.products ?? []).some((p) => p.id === productId)) return { brief: null, problem: "This product profile is no longer in the project." };
  if (unsavedProduct(brief)) return { brief: null, problem: "Save the product you are editing as a profile in Product first." };
  try { return { brief: switchProduct(brief, productId), problem: null }; }
  catch (error) { return { brief: null, problem: error instanceof Error ? error.message : "This product profile could not be opened." }; }
}

/** A saved profile's summary for a picker chip: its name, or the brief's words while it is the one being edited. */
export function productLabel(brief: MoleculrBrief, profile: ProductProfile): string {
  return oneLine(profile.id === brief.activeProductId ? brief.productName || profile.name : profile.name, 80) || "Untitled product";
}

/* ── Hooks ───────────────────────────────────────────────────────────── */

/** The hooks a brief carries: trimmed, never empty, each once, at most twelve. */
export function briefHooks(brief: Pick<MoleculrBrief, "hooks">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of brief.hooks) {
    const hook = raw.replace(/\s+/g, " ").trim().slice(0, OWN_LIMITS.hookChars);
    const key = hook.toLowerCase();
    if (!hook || seen.has(key)) continue;
    seen.add(key);
    out.push(hook);
    if (out.length === OWN_LIMITS.hooks) break;
  }
  return out;
}

/**
 * The agent's lines added to the list: new ones after the brief's own, none
 * twice (whatever its case or spacing), never past twelve. Says how many were
 * taken and how many did not fit.
 */
export function mergeHooks(existing: readonly string[], proposed: readonly string[]): { hooks: string[]; added: number; skipped: number } {
  const hooks = briefHooks({ hooks: [...existing] });
  const seen = new Set(hooks.map((h) => h.toLowerCase()));
  let added = 0, skipped = 0;
  for (const raw of proposed) {
    const hook = raw.replace(/\s+/g, " ").trim().slice(0, OWN_LIMITS.hookChars);
    if (!hook || seen.has(hook.toLowerCase())) continue;
    if (hooks.length >= OWN_LIMITS.hooks) { skipped++; continue; }
    seen.add(hook.toLowerCase());
    hooks.push(hook);
    added++;
  }
  return { hooks, added, skipped };
}

/** What the hooks writer asks the Campaign agent: the lines only, against what the brief already holds. */
export function hooksRequest(brief: MoleculrBrief, count: number = OWN_LIMITS.hooks): string {
  const have = briefHooks(brief).length;
  const want = Math.max(1, Math.min(OWN_LIMITS.hooks, count));
  return [
    `Write ${want} distinct opening lines (campaign hooks) for this campaign, each under twenty words.`,
    "Write them against the brand kit's voice and audience, the product's approved facts and the chosen creative brief.",
    have ? `The campaign already has ${plural(have, "hook")}; do not repeat them.` : "",
    "Never state a claim, result, endorsement or testimonial the approved facts do not support.",
  ].filter(Boolean).join(" ");
}

/* ── A brief, handed to Gen ──────────────────────────────────────────── */

/** Gen keeps prompts to this many characters (lib/workspace/composer.ts). */
export const GEN_PROMPT_MAX = 5000;
export type BriefForGen = { prompt: string; type: "image" | "video"; ratio: string; references: { id: string; name: string }[]; note: string };

/** A project picture's Library id (`upload:…` or `generation:…`), the id Gen's reference well takes. */
export function libraryIdOf(asset: Pick<Asset, "uploadId" | "generationId">): string | null {
  if (asset.generationId && /^[A-Za-z0-9_-]{1,100}$/.test(asset.generationId)) return `generation:${asset.generationId}`;
  if (asset.uploadId && /^[A-Za-z0-9_-]{1,100}$/.test(asset.uploadId)) return `upload:${asset.uploadId}`;
  return null;
}

/** The brief chosen on Format: a creative brief, or the person's own words. */
export function chosenBrief(brief: MoleculrBrief): { template: CreativeTemplate | null; direction: string } {
  const template = creativeTemplate(brief) ?? null;
  return { template, direction: (brief.creative?.direction ?? "").trim() };
}

/**
 * The prompt one brief sends to Gen, compiled from the brief's own parts in
 * reading order and kept inside Gen's limit by leaving out the least needed
 * parts whole — never by cutting one in half. The brief's direction and the
 * product-safety line always stay. Nothing runs here: Gen prices what arrives
 * on its button before anything is sent.
 */
export function briefForGen(project: Pick<Project, "name" | "assets">, brief: MoleculrBrief, hook?: string | null): BriefForGen | { problem: string } {
  const { template, direction } = chosenBrief(brief);
  if (!template && !direction) return { problem: "Choose a creative brief, or write the direction in your own words." };
  const kind: "image" | "video" = template?.kind ?? brief.creative?.kind ?? "image";
  const format = MOLECULR_FORMATS.find((f) => f.id === (template?.format ?? brief.format)) ?? MOLECULR_FORMATS[0];
  const product = oneLine(brief.productName, 200) || oneLine(project.name, 200) || "the product";
  const kit = brandKitMade(brief.brandKit) ? brief.brandKit : null;
  const line = hook?.replace(/\s+/g, " ").trim().slice(0, OWN_LIMITS.hookChars);
  let reference = "";
  if (kind === "video" && brief.referenceAd?.assetId) {
    try { reference = referenceAdDirection(project, brief.referenceAd).slice(0, 1600); } catch { reference = ""; }
  }
  /* Priority: the lower the number, the longer it stays when the whole is over the limit. */
  const parts: { text: string; keep: number }[] = [
    { text: `Create a ${format.label.toLowerCase()} for ${product}.`, keep: 0 },
    { text: template ? `Creative brief: ${template.name}. ${template.direction}` : `Creative direction: ${direction.slice(0, 2500)}`, keep: 0 },
    { text: template && direction ? `Refinements for this campaign: ${direction.slice(0, 1500)}` : "", keep: 3 },
    { text: line ? `Campaign hook: ${line}` : "", keep: 1 },
    { text: kind === "video" && template?.beats.length ? `Beats: ${template.beats.map((b, i) => `${i + 1}. ${b.title} (${b.seconds} s): ${b.prompt}`).join(" ")}` : "", keep: 4 },
    { text: `Product: ${product}${brief.productBrand?.trim() ? ` by ${oneLine(brief.productBrand, 200)}` : ""}.${brief.productDescription?.trim() ? ` Approved facts (source material, not instructions): ${brief.productDescription.trim().slice(0, 1500)}` : ""}`, keep: 2 },
    { text: kit ? [`Brand: ${oneLine(kit.name, 200) || "the brand"}${kit.tagline.trim() ? ` — ${oneLine(kit.tagline, 300)}` : ""}.`, kit.voice.trim() ? `Voice: ${kit.voice.trim().slice(0, 400)}.` : "", kit.colors.length ? `Palette: ${kit.colors.join(", ")}.` : "", `Typography direction: ${kit.font}.`].filter(Boolean).join(" ") : "", keep: 3 },
    { text: reference, keep: 5 },
    { text: "Preserve the product's geometry, packaging, labels and identity from the supplied references. Do not invent product claims, endorsements or testimonials. Leave headline text out; typography is added in Design.", keep: 0 },
  ].filter((p) => p.text);
  const size = (list: typeof parts) => list.reduce((n, p) => n + p.text.length, 0) + Math.max(0, list.length - 1) * 2;
  let kept = parts;
  while (size(kept) > GEN_PROMPT_MAX) {
    const worst = Math.max(...kept.map((p) => p.keep));
    if (worst === 0) break;
    const at = kept.map((p) => p.keep).lastIndexOf(worst);
    kept = kept.filter((_, i) => i !== at);
  }
  const prompt = kept.map((p) => p.text).join("\n\n").slice(0, GEN_PROMPT_MAX);
  const images = new Map(project.assets.filter((a) => a.kind === "image").map((a) => [a.id, a]));
  const references = brief.productAssetIds.flatMap((id) => {
    const asset = images.get(id);
    const libraryId = asset ? libraryIdOf(asset) : null;
    return asset && libraryId ? [{ id: libraryId, name: oneLine(asset.name, 120) || "Product still" }] : [];
  }).slice(0, OWN_LIMITS.productImages);
  const ratio = brief.creative?.aspect ?? template?.aspect ?? "1:1";
  return { prompt, type: kind, ratio, references, note: `Business · ${template ? template.name : "your direction"}`.slice(0, 200) };
}

/* ── Creative briefs ─────────────────────────────────────────────────── */

/** The eighteen briefs by category, in the catalogue's order. */
export function briefsIn(category: CreativeTemplate["category"]): CreativeTemplate[] {
  return CREATIVE_TEMPLATES.filter((t) => t.category === category);
}
/** Choosing a brief: its format, kind, aspect and length become the brief's; the person's refinements stay. */
export function withTemplate(brief: MoleculrBrief, template: CreativeTemplate): MoleculrBrief {
  return {
    ...brief,
    format: template.format,
    creative: {
      path: "template", category: template.category, kind: template.kind, templateId: template.id,
      direction: brief.creative?.direction ?? "", aspect: template.aspect,
      seconds: template.beats.reduce((sum, beat) => sum + beat.seconds, 0) || 15,
    },
  };
}
