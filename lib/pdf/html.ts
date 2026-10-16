import { PDF_FONT_FAMILY, PDF_HEAD } from "../../remotion/src/lib/pdf";
import { KIND_LABEL, PAGE_SIZES, mediaOf, type DeckDoc, type DeckPage } from "./deck";

/**
 * A deck as one HTML page for the export worker to print (remotion/node/pdf.ts). Every word is escaped; the page holds no script,
 * link, form or address, only its own style block, pictures named `assets/<file>` and the typeface `fonts/<file>`. The worker
 * checks all of this again (remotion/src/lib/pdf.ts) and the browser enforces the policy in the page's own meta tag.
 *
 * Sizes are in layout units (`--u` is 1% of the page width), so one style block fits a 16:9 slide, A4 and Letter alike.
 */
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
const paragraphs = (items: readonly string[]) => items.map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

const THEMES = {
  dark: { bg: "#0c0c10", fg: "#f4f4f7", mut: "rgba(244,244,247,.74)", line: "rgba(255,255,255,.16)", soft: "#15151b", accent: "#6cb2ff" },
  light: { bg: "#ffffff", fg: "#111114", mut: "#4a4a52", line: "#c9c9d0", soft: "#f2f2f5", accent: "#1f5fbf" },
};
const themeOf = (doc: DeckDoc) => (doc.kind === "ppm" ? THEMES.light : THEMES.dark);

function css(doc: DeckDoc): string {
  const media = mediaOf(doc);
  const t = themeOf(doc);
  const u = (media.width - 2 * doc.bleedMm) / 100; // mm per unit, measured on the trimmed page
  const widths = [...new Set(doc.pages.flatMap((p) => (p.type === "table" ? p.columns.map((c) => Math.round(c.pct)) : [])))].map((n) => `.w${n}{width:${n}%}`).join("");
  const margin = `calc(${doc.bleedMm}mm + var(--u) * 8)`;
  return `
@font-face{font-family:${PDF_FONT_FAMILY};src:url(fonts/outfit-latin-wght-normal.woff2) format("woff2");font-weight:100 900;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:${PDF_FONT_FAMILY};src:url(fonts/outfit-latin-ext-wght-normal.woff2) format("woff2");font-weight:100 900;unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@page{size:${media.width}mm ${media.height}mm;margin:0}
:root{--u:${u.toFixed(5)}mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:${t.bg}}
body{overflow-wrap:anywhere;font-family:${PDF_FONT_FAMILY},"Noto Sans","Noto Sans Devanagari",sans-serif;color:${t.fg};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{position:relative;width:${media.width}mm;height:${media.height}mm;overflow:hidden;background:${t.bg};break-after:page;page-break-after:always;padding:${margin};padding-bottom:calc(${doc.bleedMm}mm + var(--u) * 11)}
.page:last-child{break-after:auto;page-break-after:auto}
header{margin:0 0 calc(var(--u) * 2.4)}
.eyebrow{margin:0 0 calc(var(--u) * .7);font-size:calc(var(--u) * 1.15);letter-spacing:.14em;text-transform:uppercase;color:${t.accent};font-weight:600}
h1,h2,h3,p,ul,ol,li,figure,figcaption{margin:0}
h1{font-size:calc(var(--u) * 6.4);line-height:1.04;font-weight:700;letter-spacing:-.01em}h1.t2{font-size:calc(var(--u) * 4.6)}h1.t3{font-size:calc(var(--u) * 3.4)}
h2{font-size:calc(var(--u) * 3.3);line-height:1.1;font-weight:650;letter-spacing:-.005em}
.body p{font-size:calc(var(--u) * 1.75);line-height:1.5;margin:0 0 calc(var(--u) * 1.1);max-width:calc(var(--u) * 74);color:${t.fg}}
.cover{display:flex;flex-direction:column;justify-content:center;padding-bottom:calc(var(--u) * 6)}
.cover .logo{height:calc(var(--u) * 5);width:auto;max-width:calc(var(--u) * 26);object-fit:contain;object-position:left;margin:0 0 calc(var(--u) * 2.4)}
.cover .sub{font-size:calc(var(--u) * 2);line-height:1.35;color:${t.mut};margin-top:0;max-width:calc(var(--u) * 70)}
.cover .meta{font-size:calc(var(--u) * 1.4);color:${t.mut};margin-top:calc(var(--u) * 3);letter-spacing:.04em}
.cover .rule{width:calc(var(--u) * 8);height:calc(var(--u) * .5);background:${t.accent};margin:calc(var(--u) * 1.8) 0}
ul.items{padding:0;list-style:none}
ul.items li{font-size:calc(var(--u) * 1.9);line-height:1.4;padding:calc(var(--u) * .8) 0;border-bottom:1px solid ${t.line};max-width:calc(var(--u) * 74)}
table{border-collapse:collapse;width:100%;table-layout:fixed}
table.facts th{width:25%;text-align:left;font-weight:600;color:${t.mut};font-size:calc(var(--u) * 1.5);padding:calc(var(--u) * .9) calc(var(--u) * 1.2) calc(var(--u) * .9) 0;border-bottom:1px solid ${t.line};vertical-align:top}
table.facts td{font-size:calc(var(--u) * 1.75);line-height:1.4;padding:calc(var(--u) * .9) 0;border-bottom:1px solid ${t.line};vertical-align:top}
table.grid th{text-align:left;font-size:calc(var(--u) * .95);font-weight:650;color:${t.mut};padding:calc(var(--u) * .5) calc(var(--u) * .8);border-bottom:2px solid ${t.fg};background:${t.soft}}
table.grid td{font-size:calc(var(--u) * .95);line-height:1.3;padding:calc(var(--u) * .5) calc(var(--u) * .8);border-bottom:1px solid ${t.line};vertical-align:top;overflow-wrap:anywhere}
.gallery{display:grid;gap:calc(var(--u) * 1.6);height:calc(var(--u) * ${(100 * (PAGE_SIZES[doc.size].height / PAGE_SIZES[doc.size].width)).toFixed(3)} - var(--u) * 31)}
.gallery.n1{grid-template-columns:1fr}.gallery.n2{grid-template-columns:1fr 1fr}.gallery.n3,.gallery.n4{grid-template-columns:1fr 1fr}.gallery.n5,.gallery.n6{grid-template-columns:1fr 1fr 1fr}
.gallery.n3,.gallery.n4{grid-template-rows:1fr 1fr}.gallery.n5,.gallery.n6{grid-template-rows:1fr 1fr}
.gallery figure{display:flex;flex-direction:column;min-height:0;min-width:0}
.gallery img{flex:1 1 0;min-height:0;height:0;width:100%;object-fit:contain;background:${t.soft}}
.gallery figcaption{flex:none;font-size:calc(var(--u) * 1.1);color:${t.mut};padding-top:calc(var(--u) * .5);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.foot span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-right:calc(var(--u) * 2)}.foot span:last-child{white-space:nowrap}
.foot{position:absolute;left:${margin};right:${margin};bottom:calc(${doc.bleedMm}mm + var(--u) * 3.4);display:flex;justify-content:space-between;font-size:calc(var(--u) * 1.05);color:${t.mut};border-top:1px solid ${t.line};padding-top:calc(var(--u) * .9)}
.cover .foot{display:none}
${widths}
`.replace(/\n/g, "");
}

function pageHtml(page: DeckPage, index: number, total: number, doc: DeckDoc): string {
  const foot = `<footer class="foot"><span>${esc(doc.title)}</span><span>${index + 1} / ${total}</span></footer>`;
  const head = (p: { eyebrow?: string; heading: string }) => `<header>${p.eyebrow ? `<p class="eyebrow">${esc(p.eyebrow)}</p>` : ""}<h2>${esc(p.heading)}</h2></header>`;
  switch (page.type) {
    case "cover":
      return `<section class="page cover">${page.logo ? `<img class="logo" src="assets/${page.logo}" alt="">` : ""}<p class="eyebrow">${esc(KIND_LABEL[doc.kind])}</p><h1${page.title.length > 72 ? ' class="t3"' : page.title.length > 36 ? ' class="t2"' : ""}>${esc(page.title)}</h1>${page.subtitle ? `<div class="rule"></div><p class="sub">${esc(page.subtitle)}</p>` : ""}${page.meta?.length ? `<p class="meta">${esc(page.meta.join("  ·  "))}</p>` : ""}${foot}</section>`;
    case "text":
      return `<section class="page">${head(page)}<div class="body">${paragraphs(page.paragraphs)}</div>${foot}</section>`;
    case "bullets":
      return `<section class="page">${head(page)}<ul class="items">${page.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>${foot}</section>`;
    case "facts":
      return `<section class="page">${head(page)}<table class="facts"><tbody>${page.rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>${foot}</section>`;
    case "images":
      return `<section class="page">${head(page)}<div class="gallery n${Math.min(6, page.items.length)}">${page.items.map((item) => `<figure><img src="assets/${item.file}" alt="">${item.caption ? `<figcaption>${esc(item.caption)}</figcaption>` : ""}</figure>`).join("")}</div>${foot}</section>`;
    case "table":
      return `<section class="page">${head(page)}<table class="grid"><thead><tr>${page.columns.map((c) => `<th scope="col" class="w${Math.round(c.pct)}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${page.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell).replace(/\n/g, "<br>")}</td>`).join("")}</tr>`).join("")}</tbody></table>${foot}</section>`;
  }
}

export function deckHtml(doc: DeckDoc): string {
  const body = doc.pages.map((page, i) => pageHtml(page, i, doc.pages.length, doc)).join("");
  return `${PDF_HEAD}<title>${esc(doc.title)}</title><style>${css(doc)}</style></head><body><main>${body}</main></body></html>`;
}
