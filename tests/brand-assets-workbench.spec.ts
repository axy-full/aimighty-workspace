import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isCompact } from "./helpers/shellMode";
import { openAsTabs, redesignWithBoards } from "./helpers/v12Header";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * GUARD, in a browser (owner, 15 Oct 2026: "Every v25 screen uses the real assets already in public/brand ... a guard test that fails if the header or favicon uses
 * anything else"; the source-level half is tests/unit/brandAssets-guard.spec.ts). The logo that RENDERS in the new header is a picture of a file in
 * public/brand, and it loaded; every icon the page links (and the manifest's) is one of the real icon files, byte for byte as served.
 */
const ICONS = ["/favicon.svg", "/favicon.ico", "/icon.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The file a picture draws: Next serves it through /_next/image?url=<file>, so the file is that parameter. */
const fileOf = (src: string) => { const u = new URL(src, "http://x"); return u.pathname === "/_next/image" ? u.searchParams.get("url") ?? "" : u.pathname; };

async function logoIsBrand(page: Page, img: ReturnType<Page["locator"]>, label: string) {
  await expect(img, `${label}: a picture`).toBeVisible();
  const src = fileOf((await img.getAttribute("src")) ?? "");
  expect(src.startsWith("/brand/"), `${label}: ${src} is in public/brand`).toBe(true);
  expect(existsSync(`public${src}`), `${label}: ${src} exists`).toBe(true);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { message: `${label}: it loaded` }).toBe(true);
  /* No second logo: nothing else in the header draws circles or the typed word as a logo. */
  return src;
}

async function iconsOf(page: Page) {
  const links = await page.locator('head link[rel~="icon"], head link[rel="apple-touch-icon"], head link[rel="manifest"]').evaluateAll((els) => els.map((el) => ({ rel: el.getAttribute("rel") ?? "", href: el.getAttribute("href") ?? "" })));
  expect(links.filter((l) => l.rel === "manifest")).toHaveLength(1);
  expect(links.filter((l) => /icon/.test(l.rel)).length, "the page links icons").toBeGreaterThanOrEqual(4);
  const hrefs = links.filter((l) => l.rel !== "manifest").map((l) => l.href);
  const manifest = await (await page.request.get(links.find((l) => l.rel === "manifest")!.href)).json() as { icons: { src: string }[] };
  return [...hrefs, ...manifest.icons.map((i) => i.src)];
}

test.beforeEach(({}, info) => { test.skip(isCompact(info), "the header is desktop; the icons are the same on a phone (checked at the desktop sizes)"); });

test("the new interface's header draws the brand's mark and wordmark (no studio line, no lockup), and its accessible name is particl, Home", async ({ page }) => {
  const { ids } = await redesignWithBoards(page, ["Brand check"]);
  await openAsTabs(page, ids);
  const logo = page.getByTestId("v12-logo");
  await expect(logo).toHaveAccessibleName("particl, Home");
  const mark = await logoIsBrand(page, logo.locator(".brand-logo-mark img"), "the header's mark");
  const word = await logoIsBrand(page, logo.locator(".brand-logo-word img"), "the header's wordmark");
  expect(mark).toBe("/brand/particl-mark-on-dark.svg");
  expect(word).toBe("/brand/particl-wordmark-on-dark@4x.png");
  /* The wordmark file has a "studio" line under the word: the box clips it away. */
  const clipped = await logo.locator(".brand-logo-word").evaluate((box) => { const img = box.querySelector("img")!.getBoundingClientRect(), b = box.getBoundingClientRect(); return { boxH: b.height, imgH: img.height }; });
  expect(clipped.boxH, "the studio line is clipped").toBeLessThan(clipped.imgH * 0.7);
  await expect(page.getByTestId("v12-header").locator(".v12-logo-ring, .v12-logo-dot, .v12-logo-name, img[src*='lockup']")).toHaveCount(0);
  await expect(page.getByTestId("v12-header").locator("button.v12-logo svg")).toHaveCount(0);
});

test("the page's favicon, apple-touch icon and manifest icons are the real files, byte for byte (new interface and today's)", async ({ page }) => {
  await signInLocally(page.request, "Brand Tester");
  await page.goto("/suites?view=home");
  for (const href of await iconsOf(page)) {
    const file = new URL(href, "http://x").pathname;
    expect(ICONS, `${href} is a brand icon`).toContain(file);
    const served = await page.request.get(href);
    expect(served.status(), `${href} loads`).toBe(200);
    expect(sha(await served.body()), `${href} is public${file}, as served`).toBe(sha(readFileSync(`public${file}`)));
  }
});
