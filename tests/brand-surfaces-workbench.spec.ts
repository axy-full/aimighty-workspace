import { test, expect, type Locator } from "@playwright/test";
import { createClient } from "@libsql/client";
import { existsSync } from "node:fs";
import { isCompact } from "./helpers/shellMode";
import { signInLocally, localPlatformDbUrl } from "./helpers/workbenchLocal";
import { noOverflow, setSite } from "./helpers/visitorV12";

/**
 * GUARD, in a browser (owner, 15 Oct 2026, 19:30: "one small deploy #5 PR switches the error page, no-workspace page, guest header and phone top bar to the shared logo; add the
 * phone bar to the brand guard"; the source-level half is tests/unit/brandAssets-guard.spec.ts). Each of those screens draws the brand's mark and wordmark from public/brand, loaded,
 * with no typed name, and nothing overflows sideways at the five widths.
 */
const fileOf = (src: string) => { const u = new URL(src, "http://x"); return u.pathname === "/_next/image" ? u.searchParams.get("url") ?? "" : u.pathname; };

async function drawsTheBrand(logo: Locator, label: string) {
  await expect(logo, `${label}: the logo`).toBeVisible();
  for (const [part, file] of [[".brand-logo-mark img", "/brand/particl-mark-on-dark.svg"], [".brand-logo-word img", "/brand/particl-wordmark-on-dark@4x.png"]] as const) {
    const img = logo.locator(part);
    const src = fileOf((await img.getAttribute("src")) ?? "");
    expect(src, `${label}: ${part}`).toBe(file);
    expect(existsSync(`public${src}`)).toBe(true);
  }
}
const loaded = (logo: Locator, part: string) => expect.poll(() => logo.locator(part).evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);

test("the error page (a page that is not there) draws the brand's logo, not a typed name", async ({ page }) => {
  await page.goto("/this-page-is-not-there");
  const logo = page.locator("header .gx-brand .brand-logo");
  await drawsTheBrand(logo, "the error page");
  await loaded(logo, ".brand-logo-mark img");
  await expect(page.locator(".gx-brand-name")).toHaveCount(0);
  await noOverflow(page, "the error page");
});

test("the guest header draws the brand's logo at every width, and the sample's screen is named beside its back button on a phone", async ({ page }, info) => {
  await setSite({ guestHome: true, visitorPages: false });
  try {
    await page.goto("/?guest=1");
    const header = page.getByTestId("guest-header");
    await expect(header).toBeVisible({ timeout: 60_000 });
    const logo = header.getByTestId("guest-brand").locator(".brand-logo");
    await drawsTheBrand(logo, "the guest header");
    await loaded(logo, ".brand-logo-mark img");
    /* The wordmark too, on a phone as on a desktop (the app header drops it below 768 px; the guest header has no typed title to replace). */
    await expect(logo.locator(".brand-logo-word")).toBeVisible();
    await expect(header.locator(".gx-brand-name")).toHaveCount(0);
    /* On the front page there is no typed "Particl" title any more: the logo is what says it. */
    await expect(header.locator(".gx-gh-title")).toHaveCount(0);
    await noOverflow(page, `the guest header at ${info.project.name}`);
  } finally {
    await setSite({});
  }
});

test("an account with no workspace gets the no-workspace page with the brand's logo", async ({ page }) => {
  test.setTimeout(300_000);
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.batch([
      { sql: "DELETE FROM memberships WHERE account_id=?", args: [me.id] },
      { sql: "UPDATE p_sessions SET workspace_id=NULL WHERE account_id=?", args: [me.id] },
    ], "write");
  } finally {
    db.close();
  }
  await page.goto("/suites");
  await expect(page.getByTestId("no-workspace-title")).toBeVisible({ timeout: 60_000 });
  const logo = page.getByTestId("no-workspace").locator("header .gx-brand .brand-logo");
  await drawsTheBrand(logo, "the no-workspace page");
  await loaded(logo, ".brand-logo-mark img");
  await expect(page.locator(".gx-brand-name")).toHaveCount(0);
  await noOverflow(page, "the no-workspace page");
});

test("the phone's Home bar draws the brand's logo, and its heading is still Particl for a screen reader", async ({ page }, info) => {
  test.skip(!isCompact(info), "the phone app is the compact widths' own");
  await signInLocally(page.request);
  await page.goto("/suites?view=home");
  const title = page.getByTestId("phone-title");
  await expect(title).toHaveText("Particl", { timeout: 60_000 });
  const logo = title.locator(".brand-logo");
  await drawsTheBrand(logo, "the phone bar");
  await loaded(logo, ".brand-logo-word img");
  /* The words are for a reader, not the eye: no typed "Particl" is painted. */
  expect(await title.locator(".ph-sr").evaluate((el) => { const r = el.getBoundingClientRect(); return r.width * r.height; })).toBeLessThanOrEqual(1);
  await noOverflow(page, `the phone bar at ${info.project.name}`);
});
