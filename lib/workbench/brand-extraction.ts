import { parse, type HTMLElement } from "next/dist/compiled/node-html-parser";
import { withRecoveryActivity } from "../recovery";
import {
  fetchPublicProductPage,
  publicProductUrl,
  PRODUCT_PAGE_BYTES,
  ProductExtractionError,
} from "./product-fetch";
import type { BrandExtraction, BrandEvidenceSource } from "./brand-extraction-types";

const MAX_CANDIDATES = 8;
const CSS_BYTES = 256 * 1024;
const GENERIC_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math",
  "fangsong", "inherit", "initial", "unset", "revert", "revert-layer",
]);

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.slice(0, 20_000).replace(/<[^>]{0,2000}>/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function isBrand(value: unknown): boolean {
  return (Array.isArray(value) ? value.slice(0, 32) : [value]).some((item) =>
    typeof item === "string" && /^(?:https?:\/\/schema\.org\/)?(?:Organization|Brand)$/.test(item));
}

/** Do not call recursive selectors or element text getters on an untrusted tree. */
function elements(root: HTMLElement) {
  const found: HTMLElement[] = [];
  const stack = [{ node: root, depth: 0 }];
  let visits = 0, truncated = false;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++visits > 20_000) { truncated = true; break; }
    if (depth > 100) { truncated = true; continue; }
    found.push(node);
    if (["script", "style", "noscript", "template"].includes(node.rawTagName?.toLowerCase() ?? "")) continue;
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      stack.push({ node: node.childNodes[i], depth: depth + 1 });
  }
  return { found, truncated };
}
function titleText(node: HTMLElement): string {
  const pending = [...node.childNodes];
  let result = "", visits = 0;
  while (pending.length && result.length < 1000 && visits++ < 100) {
    const item = pending.shift()!;
    if (item.nodeType === 3) result += item.textContent;
    else pending.push(...item.childNodes.slice(0, 100));
  }
  return text(result, 200);
}

/** Only opaque literal CSS colors are converted; expressions are not evaluated. */
function literalColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join("")}`;
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{4}$/.test(value) && value.endsWith("f")) return literalColor(value.slice(0, 4));
  if (/^#[0-9a-f]{8}$/.test(value) && value.endsWith("ff")) return value.slice(0, 7);
  const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*(1(?:\.0+)?|100%))?\s*\)$/);
  if (!rgb) return null;
  const channels = rgb.slice(1, 4).map(Number);
  if (channels.some((n) => n > 255)) return null;
  return `#${channels.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Skip comments/URLs with a forward-only scan, including malformed unclosed input. */
function cssLiterals(value: string): string {
  const parts: string[] = [];
  const starts = /\/\*|url\(/gi;
  let offset = 0;
  for (let match = starts.exec(value); match; match = starts.exec(value)) {
    parts.push(value.slice(offset, match.index), " ");
    const closing = match[0] === "/*" ? "*/" : ")";
    const end = value.indexOf(closing, starts.lastIndex);
    if (end < 0) return parts.join("");
    offset = end + closing.length;
    starts.lastIndex = offset;
  }
  parts.push(value.slice(offset));
  return parts.join("");
}

/** Static page metadata only: no scripts, stylesheets or image URLs are executed/fetched. */
export function parseBrandPage(html: string, source: BrandExtraction["source"]): BrandExtraction {
  if (Buffer.byteLength(html, "utf8") > PRODUCT_PAGE_BYTES)
    throw new ProductExtractionError("The brand page is too large to inspect safely.", 413, "page_too_large");
  const result: BrandExtraction = {
    source, brand: { name: "", description: "", colors: [], fontFamilies: [] },
    logoCandidates: [], imageryCandidates: [], evidence: [], requiresReview: true,
    warnings: [
      "Page metadata is unverified. Review names, descriptions and claims before applying them to your brand kit.",
      "Colors and font names are page observations, not verified brand guidelines. External stylesheets and scripts were not loaded.",
      "Image candidates have not been downloaded or inspected. Import only originals you have permission to use. SVG is unsupported; image format and public network address are checked during explicit import.",
    ],
  };
  const evidence = (field: BrandExtraction["evidence"][number]["field"], kind: BrandEvidenceSource, value: string) =>
    result.evidence.push({ field, source: kind, value, sourceUrl: source.finalUrl });
  const assign = (field: "name" | "description" | "tagline", value: unknown, kind: BrandEvidenceSource, max: number) => {
    const cleaned = text(value, max);
    if (cleaned && !result.brand[field]) { result.brand[field] = cleaned; evidence(field, kind, cleaned); }
  };
  const color = (value: string, kind: BrandEvidenceSource) => {
    const cleaned = literalColor(value);
    if (cleaned && result.brand.colors.length < 8 && !result.brand.colors.includes(cleaned)) {
      result.brand.colors.push(cleaned); evidence("color", kind, cleaned);
    }
  };
  const image = (value: unknown, kind: BrandEvidenceSource, logo: boolean, alt?: unknown) => {
    const target = logo ? result.logoCandidates : result.imageryCandidates;
    if (typeof value !== "string" || target.length >= MAX_CANDIDATES) return;
    let url: URL;
    try { url = publicProductUrl(value, source.finalUrl); }
    catch { return; }
    // A content-negotiated URL still needs the explicit import's MIME and byte checks.
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { return; }
    if (/\.(?:svgz?|ico|gif|pdf)(?:$|\/)/i.test(path)) return;
    if (target.some((item) => item.url === url.href)) return;
    const caption = text(alt, 300);
    target.push({ url: url.href, source: kind, ...(caption ? { alt: caption } : {}) });
    evidence(logo ? "logo" : "image", kind, url.href);
  };
  const jsonImages = (value: unknown, logo: boolean) => {
    for (const candidate of (Array.isArray(value) ? value : [value]).slice(0, 16)) {
      const record = object(candidate);
      image(typeof candidate === "string" ? candidate : record?.contentUrl ?? record?.url, "json-ld", logo, record?.caption ?? record?.name);
    }
  };

  const { found, truncated } = elements(parse(html));
  if (truncated) result.warnings.push("The page exceeded inspection depth or node limits; extracted details may be incomplete.");
  const metadata = new Map<string, string[]>();
  const organizations: Record<string, unknown>[] = [];
  const css: string[] = [];
  let title = "", scriptCount = 0, scriptBytes = 0, jsonVisits = 0, cssBytes = 0, limited = false;
  const addCss = (value: string) => {
    const size = Buffer.byteLength(value, "utf8");
    if (css.length >= 256 || size > 64 * 1024 || cssBytes + size > CSS_BYTES) { limited = true; return; }
    cssBytes += size; css.push(value);
  };
  for (const node of found) {
    const tag = node.rawTagName?.toLowerCase();
    if (tag === "title" && !title) title = titleText(node);
    if (tag === "style") addCss(node.rawText);
    const inlineStyle = node.getAttribute?.("style");
    if (inlineStyle) addCss(inlineStyle);
    if (tag === "meta") {
      const property = (node.getAttribute("property") ?? node.getAttribute("name") ?? "").toLowerCase();
      if (["og:site_name", "og:description", "description", "og:image", "og:image:secure_url", "og:image:alt", "theme-color"].includes(property)) {
        const value = node.getAttribute("content");
        if (value && value.length <= 20_000) metadata.set(property, [...metadata.get(property) ?? [], value].slice(0, 16));
      }
    }
    if (tag !== "script" || node.getAttribute("type")?.split(";")[0].trim().toLowerCase() !== "application/ld+json") continue;
    if (++scriptCount > 20) { limited = true; continue; }
    const raw = node.rawText;
    scriptBytes += Buffer.byteLength(raw, "utf8");
    if (raw.length > 128 * 1024 || scriptBytes > 512 * 1024) { limited = true; continue; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { limited = true; continue; }
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
      const item = pending.pop()!;
      if (++jsonVisits > 2000) { limited = true; break; }
      if (item.depth > 12) { limited = true; continue; }
      if (Array.isArray(item.value)) {
        for (let i = Math.min(item.value.length, 2000) - 1; i >= 0; i--) pending.push({ value: item.value[i], depth: item.depth + 1 });
      } else {
        const record = object(item.value);
        if (!record) continue;
        if (isBrand(record["@type"])) organizations.push(record);
        const children = Object.values(record).filter((child) => child && typeof child === "object").slice(0, 2000);
        for (let i = children.length - 1; i >= 0; i--) pending.push({ value: children[i], depth: item.depth + 1 });
      }
    }
  }
  const brand = organizations.find((item) => text(item.name, 200)) ?? organizations[0];
  if (organizations.length > 1) result.warnings.push("This page describes multiple organizations or brands. Check that the selected details describe your brand.");
  if (brand) {
    assign("name", brand.name, "json-ld", 200);
    assign("description", brand.description, "json-ld", 2000);
    assign("tagline", brand.slogan, "json-ld", 300);
    jsonImages(brand.logo, true);
    jsonImages(brand.image, false);
  }
  assign("name", metadata.get("og:site_name")?.[0], "open-graph", 200);
  assign("description", metadata.get("og:description")?.[0], "open-graph", 2000);
  assign("description", metadata.get("description")?.[0], "html-meta", 2000);
  assign("name", title, "html-title", 200);
  for (const value of metadata.get("theme-color") ?? []) color(value, "html-meta");
  for (const value of [...metadata.get("og:image:secure_url") ?? [], ...metadata.get("og:image") ?? []])
    image(value, "open-graph", false, metadata.get("og:image:alt")?.[0]);

  let declarations = 0;
  for (const block of css) {
    // Ignore comments and URL tokens before inspecting bounded literal declarations.
    const cleaned = cssLiterals(block);
    const pattern = /(?:^|[;{}])\s*([\w-]{1,100})\s*:\s*([^;{}]{1,2000})/g;
    for (let match = pattern.exec(cleaned); match; match = pattern.exec(cleaned)) {
      if (++declarations > 2000) { limited = true; break; }
      const property = match[1].toLowerCase(), value = match[2].trim().replace(/\s*!important\s*$/i, "");
      if (property === "font-family") {
        for (const item of value.split(",").slice(0, 16)) {
          const name = item.trim().replace(/^(['"])(.*?)\1$/, "$2");
          if (!name || name.length > 100 || !/^[\p{L}\p{N} _-]+$/u.test(name) || GENERIC_FONTS.has(name.toLowerCase())) continue;
          if (result.brand.fontFamilies.length < 8 && !result.brand.fontFamilies.some((font) => font.toLowerCase() === name.toLowerCase())) {
            result.brand.fontFamilies.push(name); evidence("fontFamily", "inline-css", name);
          }
        }
      } else if (property.startsWith("--") || /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|accent-color)$/.test(property)) {
        for (const token of value.match(/#[\da-fA-F]{3,8}\b|rgba?\([^)]{1,100}\)/g) ?? []) color(token, "inline-css");
      }
    }
    if (declarations > 2000) break;
  }
  for (const node of found) {
    const tag = node.rawTagName?.toLowerCase();
    if (tag === "img") {
      const alt = node.getAttribute("alt");
      const marker = [alt, node.getAttribute("id"), node.getAttribute("class")].map((item) => text(item, 300)).join(" ");
      const isLogo = /(?:^|[\s_-])logo(?:$|[\s_-])/i.test(marker);
      image(node.getAttribute("src"), "html-image", isLogo, alt);
    } else if (tag === "link" && /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/i.test(node.getAttribute("rel") ?? "")) {
      if (node.getAttribute("type")?.toLowerCase() !== "image/svg+xml") image(node.getAttribute("href"), "html-link", true);
    }
  }
  if (limited) result.warnings.push("Some structured data or styles were malformed or exceeded inspection limits; extracted details may be incomplete.");
  if (!result.brand.name && !result.brand.description) result.warnings.push("No usable brand details were exposed. Enter them manually; scripts and sign-in pages are not executed.");
  return result;
}

export async function extractBrand(value: string): Promise<BrandExtraction> {
  return withRecoveryActivity("external-read", async () => {
    const page = await fetchPublicProductPage(value);
    return parseBrandPage(page.html, { requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, fetchedAt: new Date().toISOString() });
  });
}
