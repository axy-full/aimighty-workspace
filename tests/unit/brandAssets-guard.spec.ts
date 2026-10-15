import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { TRAIL } from "../../components/ui/Mark";

/**
 * GUARD (owner, 15 Oct 2026): "Logo: v25's prototype uses a placeholder (ring + dot, plain "particl"). It is NOT our brand. Every v25 screen uses the real assets
 * already in public/brand ... Add a guard test that fails if the header or favicon uses anything else."
 *
 *  (a) the favicon and the app icons are the brand's: the favicon is the brand mark's seven circles, the PNG icons are the brand's app icon;
 *  (b) every icon the app declares (metadata, manifest) is one of those files, and no `app/icon.*`, `app/favicon.*` or `app/apple-icon.*` can override them;
 *  (c) the header's logo is a file of public/brand, drawn as a picture of it (never an inline drawing or typed text), in the new header, the visitor's and today's;
 *  (d) the placeholder (a ring with a dot, or the word "particl" typed as the logo) is nowhere in components/.
 * tests/brand-assets-workbench.spec.ts checks the same in a browser: the logo that renders, the icons the page links, and that they load.
 */
const PUBLIC = "public";
const BRAND = "public/brand";
/* The icon files the app may declare, and nothing else. */
export const ICON_FILES = ["favicon.svg", "favicon.ico", "icon.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"];

const read = (file: string) => readFileSync(file, "utf8");
const circlesOf = (svg: string) => [...svg.matchAll(/<circle[^>]*\bcx="([\d.]+)"[^>]*\bcy="([\d.]+)"[^>]*\br="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
const walk = (dir: string, keep: (file: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => { const file = path.join(dir, name); return statSync(file).isDirectory() ? walk(file, keep) : keep(file) ? [file] : []; });

/** Mean absolute difference per channel between a picture and the brand icon scaled to the same size (0 = identical). */
async function differsFromBrandIcon(png: Buffer, size: number): Promise<number> {
  const a = await sharp(png).resize(size, size).removeAlpha().raw().toBuffer();
  const b = await sharp(`${BRAND}/particl-app-icon-light-1024.png`).resize(size, size).removeAlpha().raw().toBuffer();
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}
/** The PNG picture inside favicon.ico (one 64 px frame). */
function icoFrame(ico: Buffer): Buffer {
  const count = ico.readUInt16LE(4);
  expect(count, "favicon.ico holds one picture").toBe(1);
  const size = ico.readUInt32LE(6 + 8), offset = ico.readUInt32LE(6 + 12);
  const frame = ico.subarray(offset, offset + size);
  expect(frame.subarray(1, 4).toString(), "the picture is a PNG").toBe("PNG");
  return frame;
}

test("(a) the favicon is the brand mark's seven circles, the same as the mark files and the app's TRAIL", () => {
  const brand = [circlesOf(read(`${BRAND}/particl-mark-on-dark.svg`)), circlesOf(read(`${BRAND}/particl-mark-on-light.svg`))];
  expect(brand[0]).toHaveLength(7);
  expect(brand[1]).toEqual(brand[0]);
  expect(circlesOf(read(`${PUBLIC}/favicon.svg`)), "public/favicon.svg is the brand mark").toEqual(brand[0]);
  expect(TRAIL.map((t) => [...t]), "components/ui/Mark's TRAIL is the brand mark").toEqual(brand[0]);
});

test("(a) the PNG icons and favicon.ico are the brand's app icon", async () => {
  expect(readFileSync(`${PUBLIC}/icon.png`).equals(readFileSync(`${BRAND}/particl-app-icon-light-1024.png`)), "icon.png is the brand's 1024 px light app icon, byte for byte").toBe(true);
  for (const [file, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]] as const) {
    const meta = await sharp(`${PUBLIC}/${file}`).metadata();
    expect([meta.width, meta.height], `${file}'s size`).toEqual([size, size]);
    expect(await differsFromBrandIcon(readFileSync(`${PUBLIC}/${file}`), size), `${file} is the brand's app icon, scaled`).toBeLessThan(3);
  }
  /* The ico is a 64 px redrawing of it, so it is held to a looser bound than the 180 to 1024 px files. */
  expect(await differsFromBrandIcon(icoFrame(readFileSync(`${PUBLIC}/favicon.ico`)), 64), "favicon.ico is the brand's app icon, scaled").toBeLessThan(8);
  /* The check is not vacuous: the dark app icon is not "close enough". */
  expect(await differsFromBrandIcon(readFileSync(`${BRAND}/particl-app-icon-dark-1024.png`), 256)).toBeGreaterThan(50);
});

test("(b) every icon the app declares is one of those files, and nothing in app/ can override them", () => {
  const declared = [
    ...[...read("app/layout.tsx").matchAll(/["'](\/[\w@./-]+\.(?:svg|png|ico))(?:\?[^"']*)?["']/g)].map((m) => m[1]),
    ...(JSON.parse(read(`${PUBLIC}/manifest.json`)).icons as { src: string }[]).map((i) => i.src.replace(/\?.*$/, "")),
  ];
  expect(declared.length, "the layout and the manifest declare icons").toBeGreaterThanOrEqual(6);
  for (const url of declared) {
    expect(ICON_FILES.map((f) => `/${f}`), `${url} is not a brand icon`).toContain(url);
    expect(existsSync(`${PUBLIC}${url}`), `${url} exists`).toBe(true);
  }
  /* Next serves app/icon.*, app/favicon.* and app/apple-icon.* ahead of the metadata: none may exist (an old ring-of-dots icon once did). */
  const override = readdirSync("app").filter((name) => /^(icon|favicon|apple-icon|manifest)\./.test(name));
  expect(override, "files in app/ that would replace the real icons").toEqual([]);
});

test("(c) the header's logo is the brand's mark and wordmark from public/brand, drawn as pictures of them: the new header, the visitor's and the older shell's", () => {
  const logo = read("components/v12/shell/Logo.tsx");
  const mark = /export const HEADER_MARK = "([^"]+)"/.exec(logo)?.[1] ?? "";
  const word = /export const HEADER_WORDMARK = "([^"]+)"/.exec(logo)?.[1] ?? "";
  expect(mark, "the mark").toMatch(/^\/brand\/particl-mark-on-(?:dark|light)\.svg$/);
  expect(word, "the wordmark").toMatch(/^\/brand\/particl-wordmark-on-(?:dark|light)@4x\.png$/);
  for (const file of [mark, word]) expect(existsSync(`${PUBLIC}${file}`), `${file} exists`).toBe(true);
  /* Pictures of those files: the mark directly, the wordmark through Next's image route (sized(HEADER_WORDMARK, n)), as plain <img> elements. */
  expect(logo).toMatch(/<img\b[^>]*src=\{HEADER_MARK\}/);
  expect(logo).toMatch(/<img\b[^>]*src=\{sized\(HEADER_WORDMARK, 128\)\}/);
  /* No drawing and no typed name inside it, and not the full lockup: it has a "studio" line, and renders large only (sign-in, marketing, documents). */
  const body = logo.slice(logo.indexOf("export function HeaderLogo"));
  expect(body, "no inline drawing").not.toMatch(/<svg|<circle|TRAIL/);
  expect(body, "no typed wordmark").not.toMatch(/>\s*particl\s*</i);
  expect(logo.replace(/\/\*[\s\S]*?\*\//g, ""), "the header uses no lockup").not.toMatch(/particl-lockup/);
  /* Both v12 headers draw it through HeaderLogo, and neither makes a logo of its own. */
  for (const file of ["components/v12/shell/Header.tsx", "components/v12/visitor/VisitorHeader.tsx"]) {
    const text = read(file);
    expect(text, `${file} draws HeaderLogo`).toMatch(/<HeaderLogo\b/);
    expect(text, `${file} draws no logo of its own`).not.toMatch(/TRAIL|className="v12-logo|Mark"|particl-lockup/);
  }
  /* The older shell's header (components/shell/Header.tsx): its logo picture is a brand file. */
  const today = read("components/shell/Header.tsx");
  const todays = [...today.matchAll(/<Image[\s\S]*?\bsrc="([^"]+)"/g)].map((m) => m[1]);
  expect(todays.length, "today's header draws its logo as an Image").toBeGreaterThan(0);
  for (const url of todays) expect(url.startsWith("/brand/") && existsSync(`${PUBLIC}${url}`), `the shell header's logo ${url}`).toBe(true);
});

/**
 * The full lockup (mark, wordmark and its "studio" line) is for where it renders large (owner, 15 Oct: "sign-in, marketing, documents"). These are the only surfaces that
 * may name a lockup file; a header, a bar or a tab strip may not. Add a surface here only on the owner's word.
 */
export const LOCKUP_SURFACES = [
  "lib/mail.ts", /* documents: the emails' header */
  "components/WelcomeSignIn.tsx", "components/AuthCard.tsx", /* sign-in */
  "components/marketing/", /* marketing */
];
test("(c) the full lockup is named only on sign-in, marketing and document surfaces", () => {
  const files = [...walk("components", (f) => /\.(tsx?|css)$/.test(f)), ...walk("app", (f) => /\.(tsx?|css)$/.test(f)), ...walk("lib", (f) => /\.tsx?$/.test(f))];
  const using = files.filter((file) => /particl-lockup/.test(read(file)));
  const stray = using.filter((file) => !LOCKUP_SURFACES.some((surface) => file === surface || (surface.endsWith("/") && file.startsWith(surface))));
  expect(stray, "files that use the full lockup outside sign-in, marketing and documents").toEqual([]);
  expect(using.length, "the lockup is used somewhere (documents), so this check is looking at something").toBeGreaterThan(0);
});

/**
 * Today's customer header (components/graphite/Header.tsx) draws the brand's mark (an inline copy of its seven circles, checked in (a)) and then types the name
 * "particl" as text. The owner's 15 Oct rule calls a typed-text logo a placeholder. It is customer-facing, so it is NOT changed in the v25 foundation PRs; it is recorded
 * here as a known gap, and this list may only shrink: another header with a typed name fails, and so does the day the gap is fixed (delete its entry).
 */
export const TYPED_NAME_HEADERS = ["components/graphite/Header.tsx"];
test("(c) no header types its name as the logo, except the known gap the owner decides (today's customer header)", () => {
  const headers = ["components/graphite/Header.tsx", "components/shell/Header.tsx", "components/v12/shell/Header.tsx", "components/v12/shell/Logo.tsx", "components/v12/visitor/VisitorHeader.tsx"];
  const typed = headers.filter((file) => /className="[^"]*(?:brand-name|logo-name|wordmark-text)[^"]*"[^>]*>\s*particl\s*</i.test(read(file)));
  expect(typed, "headers that type their name; fix it with the lockup, or add it here only on the owner's word").toEqual(TYPED_NAME_HEADERS);
});

/** The placeholder, as source: the ring and dot of the v25 prototype's logo, or a logo that is only the typed word. */
export const PLACEHOLDER = [
  { name: "the ring-and-dot mark", re: /\bv12-logo-(?:ring|dot)\b/i },
  { name: "the typed-text logo", re: /\bv12-logo-name\b/i },
  { name: "a logo element holding only the word particl", re: /className=["'][^"']*\blogo[^"']*["'][^>]*>\s*(?:<[^>]+>\s*)*particl\s*</i },
];
const placeholdersIn = (text: string) => PLACEHOLDER.filter((p) => p.re.test(text)).map((p) => p.name);

test("(d) the placeholder logo is nowhere in components/ (design/ keeps the prototype's)", () => {
  const files = walk("components", (f) => /\.(tsx?|css)$/.test(f));
  expect(files.length).toBeGreaterThan(100);
  const found = files.flatMap((file) => placeholdersIn(read(file)).map((what) => `${file}: ${what}`));
  expect(found, "the v25 prototype's placeholder logo is not the brand").toEqual([]);
});

test("(d) the matcher sees the placeholder and leaves ordinary words alone", () => {
  const ring = `<span className="v12-logo-ring"><span className="v12-logo-dot" /></span>`;
  expect(placeholdersIn(ring)).toEqual(["the ring-and-dot mark"]);
  expect(placeholdersIn(`<span className="brand-tool-logo-name">Your logo</span>`)).toEqual([]);
  expect(placeholdersIn(`<span className="v12-logo-name">particl</span>`)).toContain("the typed-text logo");
  expect(placeholdersIn(`<a className="brand-logo" href="/"><b>particl</b></a>`)).toEqual(["a logo element holding only the word particl"]);
  expect(placeholdersIn(`<button className="v12-logo"><Image src={HEADER_LOGO} alt="" /></button>`)).toEqual([]);
  expect(placeholdersIn(`<p>Welcome to particl, a studio for film</p>`)).toEqual([]);
  expect(placeholdersIn(`.v12 .v12-logo-img { height: 36px; }`)).toEqual([]);
});
