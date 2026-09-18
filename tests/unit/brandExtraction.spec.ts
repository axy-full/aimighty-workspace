import { test, expect } from "@playwright/test";
import { parseBrandPage, extractBrand } from "../../lib/workbench/brand-extraction";
import { PRODUCT_PAGE_BYTES } from "../../lib/workbench/product-fetch";

const source = {
  requestedUrl: "https://shop.example.com/brand",
  finalUrl: "https://shop.example.com/about/brand",
  fetchedAt: "2026-09-18T00:00:00.000Z",
};
const jsonLd = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

test("brand facts come from Organization/Brand metadata with bounded provenance and no invented tone", () => {
  const result = parseBrandPage(`<meta property="og:site_name" content="Fallback">${jsonLd({
    "@graph": [{ "@type": "Product", name: "Product is not brand" }, {
      "@type": ["Thing", "https://schema.org/Organization"], name: "Acme", description: "<b>Page supplied</b> description",
      slogan: "Less packaging", tone: "invent this", audience: "everyone",
      logo: { contentUrl: "/logo.png", caption: "Acme logo" }, image: ["/hero.jpg", { url: "https://cdn.example.com/store.webp", name: "Store" }],
    }],
  })}`, source);
  expect(result.brand).toEqual({ name: "Acme", description: "Page supplied description", tagline: "Less packaging", colors: [], fontFamilies: [] });
  expect(result.logoCandidates).toEqual([{ url: "https://shop.example.com/logo.png", source: "json-ld", alt: "Acme logo" }]);
  expect(result.imageryCandidates).toHaveLength(2);
  expect(result.source).toEqual(source);
  expect(result.requiresReview).toBe(true);
  expect(result.evidence.map((item) => item.field)).toEqual(["name", "description", "tagline", "logo", "image", "image"]);
  expect(result.evidence.every((item) => item.sourceUrl === source.finalUrl)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/audience|uploadId|storedUrl|assetId|invent this/);
});

test("fallback uses decoded site metadata and title, never a product title as an asserted site name", () => {
  const result = parseBrandPage('<script type="application/ld+json">{broken</script><META PROPERTY="og:site_name" CONTENT="A &amp; B"><meta property="og:title" content="A product"><meta property="og:description" content="Description"><title>Title</title>', source);
  expect(result.brand.name).toBe("A & B");
  expect(result.brand.description).toBe("Description");
  expect(result.evidence[0].source).toBe("open-graph");
  expect(result.warnings.join(" ")).toContain("malformed");
  const fallback = parseBrandPage('<title>Title &amp; brand</title><meta name="description" content="Meta description">', source);
  expect(fallback.brand).toMatchObject({ name: "Title & brand", description: "Meta description" });
  expect(fallback.evidence.map((item) => item.source)).toEqual(["html-meta", "html-title"]);
  expect(fallback.brand).not.toHaveProperty("tagline");
  expect(fallback.brand).not.toHaveProperty("tone");
});

test("opaque theme and CSS colors normalize to hex6; literal named font metadata is not loaded", () => {
  const result = parseBrandPage(`<meta name="theme-color" content="#A3c"><style>
    /* color: #ff0000; font-family: Fake; */
    @import url(https://tracking.example.com/style.css);
    :root { --brand-color: #aabbcc; --transparent: #abcd; --opaque: #123f; }
    body { color: rgb(10, 20, 30); background-color: rgba(1, 2, 3, 1); font-family: 'Brand Sans', Arial, sans-serif; }
    .a { background: url(https://cdn.example.com/a.png#fedcba); color: rgba(4, 5, 6, .5); }
    .b { font-family: var(--font); color: #123456ff; }
    </style><p style="color:#aabbcc; font-family:&quot;Brand Sans&quot;, Georgia, serif">Hello</p>`, source);
  expect(result.brand.colors).toEqual(["#aa33cc", "#aabbcc", "#112233", "#0a141e", "#010203", "#123456"]);
  expect(result.brand.colors.every((value) => /^#[a-f0-9]{6}$/.test(value))).toBe(true);
  expect(result.brand.fontFamilies).toEqual(["Brand Sans", "Arial", "Georgia"]);
  expect(result.evidence.find((item) => item.field === "color")).toMatchObject({ source: "html-meta" });
  expect(result.warnings.join(" ")).toContain("External stylesheets and scripts were not loaded");
});

test("image candidates reject private or executable URLs, unsupported SVG and credentials; ignore base and scripts", () => {
  const unsafe = ["http://127.0.0.1/a", "http://[::1]/a", "http://2130706433/a", "http://0x7f000001/a", "http://metadata.internal/a", "http://local.test/a", "https://user:secret@cdn.example.com/a", "https://cdn.example.com:8080/a", "data:image/png;base64,AAAA", "javascript:alert(1)", "/logo.svg", "/logo.%73vg", "/logo.svgz", "/favicon.ico"];
  const result = parseBrandPage(`<base href="http://127.0.0.1/">${jsonLd({ "@type": "Brand", name: "Brand", logo: unsafe.slice(0, 8), image: unsafe.slice(8) })}
    <img alt="Brand logo" src="/real.png"><img class="brand-logo" src="/real.png"><img src="/photo.webp" alt="Product">
    <link rel="icon" href="/icon.png"><link rel="icon" type="image/svg+xml" href="/svg-without-extension">
    <script>throw new Error('SCRIPT EXECUTED'); fetch('https://tracking.example.com')</script>
    <noscript><img src="/no.png"></noscript><template><img src="/template.png"></template>`, source);
  expect(result.logoCandidates.map((item) => item.url)).toEqual(["https://shop.example.com/real.png", "https://shop.example.com/icon.png"]);
  expect(result.imageryCandidates).toEqual([{ url: "https://shop.example.com/photo.webp", source: "html-image", alt: "Product" }]);
  expect(JSON.stringify(result)).not.toMatch(/127\.0\.0\.1|secret|SCRIPT EXECUTED|<script|template.png/);
  expect(result.warnings.join(" ")).toContain("SVG is unsupported");
});

test("all collection and text bounds hold under excess structured metadata, palette, fonts and imagery", () => {
  const images = Array.from({ length: 50 }, (_, i) => `/image-${i}.jpg`);
  const styles = Array.from({ length: 40 }, (_, i) => `.c${i}{color:#${i.toString(16).padStart(6, "0")};font-family:Font${i};}`).join("");
  const result = parseBrandPage(`${jsonLd({ "@type": "Organization", name: "n".repeat(1000), description: "d".repeat(5000), slogan: "s".repeat(1000), image: images, logo: images })}<style>${styles}</style>`, source);
  expect(result.brand.name).toHaveLength(200);
  expect(result.brand.description).toHaveLength(2000);
  expect(result.brand.tagline).toHaveLength(300);
  expect(result.brand.colors).toHaveLength(8);
  expect(result.brand.fontFamilies).toHaveLength(8);
  expect(result.logoCandidates).toHaveLength(8);
  expect(result.imageryCandidates).toHaveLength(8);
  expect(result.evidence.length).toBeLessThanOrEqual(35);
  expect(() => parseBrandPage("x".repeat(PRODUCT_PAGE_BYTES + 1), source)).toThrow(/too large/);
  expect(() => parseBrandPage("é".repeat(PRODUCT_PAGE_BYTES / 2 + 1), source)).toThrow(/too large/);
});

test("deep and oversized metadata is skipped without losing safe fallbacks", () => {
  let nested: object = { "@type": "Organization", name: "Too deep" };
  for (let i = 0; i < 30; i++) nested = { child: nested };
  const result = parseBrandPage(`${jsonLd(nested)}${jsonLd({ value: "x".repeat(130 * 1024) })}<style>${"x".repeat(65 * 1024)}</style><title>Safe title</title>${"<div>".repeat(12_000)}text${"</div>".repeat(12_000)}`, source);
  expect(result.brand.name).toBe("Safe title");
  expect(result.warnings.join(" ")).toContain("limits");
  expect(result.warnings.length).toBeLessThanOrEqual(6);
  const multiple = parseBrandPage(jsonLd([{ "@type": "Brand", name: "First" }, { "@type": "Brand", name: "Second" }]), source);
  expect(multiple.brand.name).toBe("First");
  expect(multiple.warnings.join(" ")).toContain("multiple organizations");
});

test("brand extraction rejects private page URLs before opening a connection", async () => {
  for (const url of ["http://127.0.0.1/secret", "http://[::1]/secret", "https://host.internal/secret", "file:///etc/passwd"])
    await expect(extractBrand(url)).rejects.toMatchObject({ code: "unsafe_url" });
});

test("malformed CSS comments and URL tokens cannot contribute colors or fonts", () => {
  const result = parseBrandPage(`<style>body {color:#123456;} /* ${"/* ".repeat(20_000)} .hidden{color:#abcdef;font-family:Hidden;}</style>
    <style>body {font-family:Visible;} .bg{background:url(${"url(".repeat(10_000)};color:#ff0000;font-family:Hidden;}</style>`, source);
  expect(result.brand.colors).toEqual(["#123456"]);
  expect(result.brand.fontFamilies).toEqual(["Visible"]);
});
