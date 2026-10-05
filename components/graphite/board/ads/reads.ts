import type { BrandExtraction } from "@/lib/workbench/brand-extraction-types";
import type { MoleculrBrief } from "@/lib/workbench/moleculr";
import { EMPTY_BRAND_KIT, brandKitSchema, saveProduct, type BrandKit } from "@/lib/workbench/moleculr-creative";
import type { ProductExtraction } from "@/lib/workbench/product-extraction-types";
import { OWN_LIMITS } from "@/lib/shell/business-own";

/*
 * The Ads board's two free reads of a public page (the existing routes the Brand and Product tools use):
 * `extract-product` for the product page and `extract-brand` for the brand's home page. Each reads one page,
 * returns observations and never an approved value: the person approves them on the card. Pure checks and the
 * pure "apply what was reviewed" steps live here so they are tested without a browser.
 */

/** A public http or https address, or why it is not one. The reads' own refusals (private hosts, size) come from the route. */
export function siteUrl(value: string): { ok: true; url: URL } | { ok: false; reason: string } {
  const text = value.trim();
  if (!text) return { ok: false, reason: "Enter the product page, starting with https://" };
  let url: URL;
  try { url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`); } catch { return { ok: false, reason: "Enter the product page, starting with https://" }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "Use a public http or https page." };
  if (!url.hostname.includes(".")) return { ok: false, reason: "Enter the product page, starting with https://" };
  return { ok: true, url };
}

/** The brand's home page for a product page: the origin, read for the brand kit. */
export const brandHome = (url: URL): string => `${url.protocol}//${url.host}/`;

export const hostOf = (url: string | undefined): string => {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

type Reply<T> = Partial<T> & { error?: string };
async function post<T>(path: string, scope: string, body: unknown, signal?: AbortSignal): Promise<Reply<T>> {
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify(body), signal,
  });
  const data = await response.json().catch(() => ({})) as Reply<T>;
  if (!response.ok) throw new Error(data.error || "The page could not be read.");
  return data;
}

export async function readProductPage(scope: string, projectId: string, url: string, signal?: AbortSignal): Promise<ProductExtraction> {
  const data = await post<ProductExtraction>("/api/workbench/moleculr/extract-product", scope, { projectId, url }, signal);
  if (!data.product || !data.source || !Array.isArray(data.imageCandidates) || !Array.isArray(data.evidence) || !Array.isArray(data.warnings) || data.requiresReview !== true)
    throw new Error("The product page returned an incomplete review. Write the details by hand, or try another page.");
  return data as ProductExtraction;
}

export async function readBrandPage(scope: string, projectId: string, url: string, signal?: AbortSignal): Promise<BrandExtraction> {
  const data = await post<BrandExtraction>("/api/workbench/moleculr/extract-brand", scope, { projectId, url }, signal);
  if (!data.brand || !data.source || !Array.isArray(data.brand.colors) || !Array.isArray(data.brand.fontFamilies) || !Array.isArray(data.logoCandidates)
    || !Array.isArray(data.imageryCandidates) || !Array.isArray(data.evidence) || !Array.isArray(data.warnings) || data.requiresReview !== true)
    throw new Error("The website returned an incomplete review. Write the details by hand, or try another page.");
  return data as BrandExtraction;
}

/** What a read shows on the card before it is approved: the values, never written to the draft. */
export type BrandReview = { name: string; description: string; tagline: string; colors: string[]; fontFamilies: string[]; tone: string };
export function brandReview(ex: BrandExtraction): BrandReview {
  return {
    name: String(ex.brand.name ?? "").slice(0, 200), description: String(ex.brand.description ?? "").slice(0, 4000), tagline: String(ex.brand.tagline ?? "").slice(0, 300),
    colors: ex.brand.colors.slice(0, OWN_LIMITS.colors), fontFamilies: ex.brand.fontFamilies.slice(0, OWN_LIMITS.fontFamilies), tone: String(ex.brand.tone ?? "").slice(0, 400),
  };
}

/** Approving a brand read: its name, words, colours, typefaces and source go on the kit; voice, audience and logo stay the person's to write. */
export function approveBrand(current: BrandKit | undefined, ex: BrandExtraction, now: Date = new Date()): { kit: BrandKit } | { error: string } {
  const review = brandReview(ex);
  const base = current ?? EMPTY_BRAND_KIT;
  const next = brandKitSchema.safeParse({
    ...base, name: review.name, description: review.description, tagline: review.tagline,
    ...(review.colors.length ? { colors: [...new Set(review.colors)] } : {}),
    ...(review.fontFamilies.length ? { fontFamilies: [...new Set(review.fontFamilies)] } : {}),
    source: { url: ex.source.finalUrl, reviewedAt: now.toISOString() },
  });
  return next.success ? { kit: next.data } : { error: "The read has colours or typefaces the kit cannot hold. Use Edit to correct them." };
}

/** Approving a product read: the reviewed name, brand and facts become the product's, and the profile is saved (one tap). */
export function approveProduct(brief: MoleculrBrief, ex: ProductExtraction, id: string, now: Date = new Date()): { brief: MoleculrBrief } | { error: string } {
  const name = ex.product.name.trim().slice(0, 200);
  if (!name) return { error: "The page gave no product name. Use Edit to write it." };
  const set: MoleculrBrief = {
    ...brief, productName: name, productUrl: ex.source.finalUrl, productDescription: ex.product.description.slice(0, 4000), productBrand: ex.product.brand.slice(0, 200),
    productSource: { url: ex.source.finalUrl, title: name, reviewedAt: now.toISOString() },
  };
  try { return { brief: saveProduct(set, brief.activeProductId || id) }; }
  catch (cause) { return { error: cause instanceof Error ? cause.message : "The profile could not be saved." }; }
}
