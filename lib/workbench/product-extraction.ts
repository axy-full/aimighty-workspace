import { parse, type HTMLElement } from "next/dist/compiled/node-html-parser";
import { withRecoveryActivity } from "../recovery";
import {
  fetchPublicProductPage,
  publicProductUrl,
  PRODUCT_PAGE_BYTES,
  ProductExtractionError,
} from "./product-fetch";
import type {
  ProductExtraction,
  ProductEvidenceSource,
} from "./product-extraction-types";

const MAX_IMAGES = 8;
function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 20_000)
    .replace(/<[^>]{0,2000}>/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function isProduct(value: unknown) {
  return (Array.isArray(value) ? value : [value]).some(
    (type) =>
      typeof type === "string" &&
      [
        "Product",
        "https://schema.org/Product",
        "http://schema.org/Product",
      ].includes(type),
  );
}
/** Traversal budgets avoid recursive HTML selectors/text getters on hostile trees. */
function elements(root: HTMLElement) {
  const found: HTMLElement[] = [];
  const stack = [{ node: root, depth: 0 }];
  let count = 0,
    truncated = false;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 20_000) {
      truncated = true;
      break;
    }
    if (depth > 100) {
      truncated = true;
      continue;
    }
    found.push(node);
    if (
      ["script", "style", "noscript"].includes(
        node.rawTagName?.toLowerCase() ?? "",
      )
    )
      continue;
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      stack.push({ node: node.childNodes[i], depth: depth + 1 });
  }
  return { found, truncated };
}
function titleText(node: HTMLElement): string {
  const queue = [...node.childNodes];
  let result = "",
    count = 0;
  while (queue.length && result.length < 1000 && count++ < 100) {
    const item = queue.shift()!;
    if (item.nodeType === 3) result += item.textContent;
    else queue.push(...item.childNodes.slice(0, 100));
  }
  return text(result, 200);
}

/** No scripts are executed, URLs followed, claims approved or project data saved. */
export function parseProductPage(
  html: string,
  source: ProductExtraction["source"],
): ProductExtraction {
  if (Buffer.byteLength(html, "utf8") > PRODUCT_PAGE_BYTES)
    throw new ProductExtractionError(
      "The product page is too large to inspect safely.",
      413,
      "page_too_large",
    );
  const result: ProductExtraction = {
    source,
    product: { name: "", description: "", brand: "" },
    evidence: [],
    imageCandidates: [],
    warnings: [
      "Page metadata is unverified. Review and edit it before using any product claims.",
      "Image candidates have not been downloaded or inspected. Import only originals you have permission to use.",
    ],
    requiresReview: true,
  };
  const { found, truncated } = elements(parse(html));
  if (truncated)
    result.warnings.push(
      "The page exceeded the inspection depth or node limit; extracted details may be incomplete.",
    );
  const metadata = new Map<string, string[]>();
  const products: Record<string, unknown>[] = [];
  let title = "",
    scripts = 0,
    scriptBytes = 0,
    malformed = false,
    visits = 0;
  for (const node of found) {
    const tag = node.rawTagName?.toLowerCase();
    if (tag === "title" && !title) title = titleText(node);
    if (tag === "meta") {
      const property = (
        node.getAttribute("property") ??
        node.getAttribute("name") ??
        ""
      ).toLowerCase();
      if (
        ![
          "og:title",
          "og:description",
          "og:image",
          "og:image:secure_url",
          "og:image:alt",
          "product:brand",
        ].includes(property)
      )
        continue;
      const value = node.getAttribute("content");
      if (value && value.length <= 20_000)
        metadata.set(
          property,
          [...(metadata.get(property) ?? []), value].slice(0, 16),
        );
    }
    if (
      tag !== "script" ||
      node.getAttribute("type")?.split(";")[0].trim().toLowerCase() !==
        "application/ld+json"
    )
      continue;
    if (++scripts > 20) {
      malformed = true;
      continue;
    }
    // rawText preserves JSON string entity spellings; HTML text decoding would alter it.
    const raw = node.rawText;
    scriptBytes += Buffer.byteLength(raw, "utf8");
    if (raw.length > 128 * 1024 || scriptBytes > 512 * 1024) {
      malformed = true;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      malformed = true;
      continue;
    }
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
      const item = pending.pop()!;
      if (++visits > 2000) {
        malformed = true;
        break;
      }
      if (item.depth > 12) {
        malformed = true;
        continue;
      }
      if (Array.isArray(item.value)) {
        for (let i = Math.min(item.value.length, 2000) - 1; i >= 0; i--)
          pending.push({ value: item.value[i], depth: item.depth + 1 });
      } else {
        const record = object(item.value);
        if (!record) continue;
        if (isProduct(record["@type"])) products.push(record);
        const children = Object.values(record)
          .filter((child) => child && typeof child === "object")
          .slice(0, 2000);
        for (let i = children.length - 1; i >= 0; i--)
          pending.push({ value: children[i], depth: item.depth + 1 });
      }
    }
  }
  if (malformed)
    result.warnings.push(
      "Some structured metadata was malformed or exceeded inspection limits; review the available fields.",
    );
  const product = products.find((item) => text(item.name, 200)) ?? products[0];
  if (products.length > 1)
    result.warnings.push(
      "This page describes several products. Check that the selected details match your product.",
    );
  if (!product)
    result.warnings.push(
      "No Product structured data was found. Available page metadata is shown instead.",
    );
  const assign = (
    field: "name" | "description" | "brand",
    value: unknown,
    evidence: ProductEvidenceSource,
    max: number,
  ) => {
    const cleaned = text(value, max);
    if (!cleaned || result.product[field]) return;
    result.product[field] = cleaned;
    result.evidence.push({
      field,
      value: cleaned,
      source: evidence,
      sourceUrl: source.finalUrl,
    });
  };
  if (product) {
    assign("name", product.name, "json-ld", 200);
    assign("description", product.description, "json-ld", 2000);
    assign(
      "brand",
      typeof product.brand === "string"
        ? product.brand
        : object(product.brand)?.name,
      "json-ld",
      200,
    );
  }
  assign("name", metadata.get("og:title")?.[0], "open-graph", 200);
  assign(
    "description",
    metadata.get("og:description")?.[0],
    "open-graph",
    2000,
  );
  assign("brand", metadata.get("product:brand")?.[0], "open-graph", 200);
  assign("name", title, "html-title", 200);
  const image = (
    value: unknown,
    kind: "json-ld" | "open-graph",
    alt?: unknown,
  ) => {
    if (
      result.imageCandidates.length >= MAX_IMAGES ||
      typeof value !== "string"
    )
      return;
    let url: string;
    try {
      url = publicProductUrl(value, source.finalUrl).href;
    } catch {
      return;
    }
    if (result.imageCandidates.some((item) => item.url === url)) return;
    const caption = text(alt, 300);
    result.imageCandidates.push({
      url,
      source: kind,
      ...(caption ? { alt: caption } : {}),
    });
    result.evidence.push({
      field: "image",
      source: kind,
      value: url,
      sourceUrl: source.finalUrl,
    });
  };
  for (const candidate of (Array.isArray(product?.image)
    ? product.image
    : [product?.image]
  ).slice(0, 16)) {
    const record = object(candidate);
    image(
      typeof candidate === "string"
        ? candidate
        : (record?.contentUrl ?? record?.url),
      "json-ld",
      record?.caption,
    );
  }
  for (const value of [
    ...(metadata.get("og:image:secure_url") ?? []),
    ...(metadata.get("og:image") ?? []),
  ])
    image(value, "open-graph", metadata.get("og:image:alt")?.[0]);
  if (!result.product.name && !result.product.description)
    result.warnings.push(
      "No usable product details were exposed by this page. Enter them manually; scripts and sign-in pages are not executed.",
    );
  return result;
}

export async function extractProduct(
  value: string,
): Promise<ProductExtraction> {
  return withRecoveryActivity("external-read", async () => {
    const page = await fetchPublicProductPage(value);
    return parseProductPage(page.html, {
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      fetchedAt: new Date().toISOString(),
    });
  });
}
