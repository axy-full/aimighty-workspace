import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { DESKTOP } from "./helpers/appPagesAudit";
import { lastRowClearsPinned } from "./phoneFloors";
import { siteOrigin } from "../lib/site";

/**
 * Part of the app-pages audit, in a real browser against a local ENGINE_MOCK=1
 * server: entry points, Workspace › Engines and the platform desk, and public
 * metadata. Nothing here submits paid work. The audit is spread over files
 * whose names sort apart, because CI shards take contiguous runs of files and
 * each legacy page costs its dev server gigabytes to compile.
 */

test("entry points: a workspace goes straight to Suites; a visitor signs in and comes back to the same page", async ({ page, browser }, info) => {
  test.skip(info.project.name !== DESKTOP, "Redirects, once.");
  const visitor = await browser.newPage();
  try {
    const link = "/suites?suite=atomik&page=runs&project=p1";
    await visitor.goto(link);
    await expect(visitor).toHaveURL(`/login?next=${encodeURIComponent(link)}`);
    /* An old app address signs a visitor in and brings them back to its new address. */
    await visitor.goto("/generate?mode=images&task=upscale");
    await expect(visitor).toHaveURL(`/login?next=${encodeURIComponent("/suites?task=upscale&make=image&view=home")}`);
  } finally {
    await visitor.close();
  }

  await signInLocally(page.request);
  /* The switch is the response itself — a 307 — not a 200 carrying a meta refresh. */
  for (const [entry, target] of [["/", /^\/suites\?view=home$/], ["/atomik", /^\/suites\?atomik=1&view=home$/], ["/subatomik", /^\/suites\?make=motion&view=home$/], ["/workbench", /^\/suites\?view=home$/]] as const) {
    const res = await page.request.get(entry, { maxRedirects: 0 });
    expect(res.status(), entry).toBe(307);
    expect(res.headers().location, entry).toMatch(target);
  }
  /* The other (app) redirect pages answer the same way now that the shell streams no boundary. */
  const moved = await page.request.get("/images", { maxRedirects: 0 });
  expect(moved.status()).toBe(307);
  const response = await page.goto("/workbench?stage=brief");
  /* One hop: /workbench?stage=brief is answered by one 307 to the board's Brief region, and /suites moves it no further. */
  const hop = response?.request().redirectedFrom();
  expect(hop?.url()).toContain("/workbench?stage=brief");
  expect(hop?.redirectedFrom()).toBeNull();
  await expect(page).toHaveURL(/\/suites\?(?=.*view=board)(?=.*region=brief)/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/suites\?(?=.*view=home)/);
});

test("Settings › Connections lists no tokens and offers to make one; the platform desk is for the platform owner only", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Links, once.");
  await signInLocally(page.request);
  /* /connect is Settings › Connections now. */
  await page.goto("/connect");
  await expect(page).toHaveURL(/\/suites\?(?=.*view=workspace)(?=.*tab=connections)/);
  /* Engines is Advanced › Models and the token page's job (listing and making tokens) is Connections. */
  await page.goto("/suites?view=workspace&tab=connections");
  await expect(page.getByTestId("settings-title")).toHaveText("Connections");
  await expect(page.getByTestId("settings-tokens-empty")).toContainText("No tokens yet");
  await expect(page.getByTestId("settings-token-make")).toBeVisible();
  /* The avatar's menu offers the platform desk to the platform owner alone. */
  await page.getByTestId("workspace-avatar").click();
  await expect(page.getByTestId("settings-menu")).toBeVisible();
  await expect(page.getByTestId("settings-platform-desk")).toHaveCount(0);
  await expect(page.getByTestId("platform-desk")).toHaveCount(0);
});

test("on a phone, Connections' tokens section is the last card on the page and ends above the tab bar", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-390x844"].includes(info.project.name), "the phones with a pinned tab bar");
  await signInLocally(page.request);
  /* The Higgsfield sign-in is off for Release 1: Settings has no connected-account row and never reads the account. */
  const accountReads: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/higgsfield/consumer/")) accountReads.push(request.url()); });
  await page.goto("/suites?view=workspace&tab=advanced&open=models");
  /* Everything above it has loaded, so nothing moves it after the measure. */
  await expect(page.getByTestId("settings-engines").locator(".gs-row-v")).not.toHaveText("Reading…");
  await page.getByTestId("settings-engines-show").click();
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  expect(accountReads).toEqual([]);
  /* The developer-API check went with the Higgsfield sign-in. */
  await expect(page.getByTestId("engine-developer-api")).toHaveCount(0);
  /* The phone's Settings is a page under the phone header; its scroller ends above the tab bar. */
  await page.goto("/suites?view=workspace&tab=connections");
  await expect(page.getByTestId("settings-token-make")).toBeVisible();
  expect(await lastRowClearsPinned(page), "the last row clears the tab bar").toEqual([]);
});

test("public metadata: robots, sitemap, one icon per URL, and client review pages without Particl's install card", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== DESKTOP, "Metadata, once.");
  /* The server builds these URLs with siteOrigin() from its APP_ORIGIN (CI gives the
     runner the same env); a local run without it falls back to the server it is testing. */
  const origin = siteOrigin() ?? new URL(baseURL!).origin;
  const robots = await (await page.request.get("/robots.txt")).text();
  for (const path of ["/api/", "/invite/", "/reset/"]) expect(robots).toContain(`Disallow: ${path}`);
  /* A review link may be fetched for its preview card; noindex (meta and header) keeps it out of every index. */
  expect(robots).not.toContain("Disallow: /review/");
  expect((await page.request.get("/review/not-a-real-token")).headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect((await page.request.get("/terms")).headers()["x-robots-tag"]).toBeUndefined();
  expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`);
  expect(await (await page.request.get("/sitemap.xml")).text()).toContain(`<loc>${origin}/terms</loc>`);
  const icon = await page.request.get("/icon.png");
  expect(createHash("sha1").update(await icon.body()).digest("hex")).toBe(createHash("sha1").update(readFileSync("public/icon.png")).digest("hex"));

  await page.goto("/terms");
  const literal = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", new RegExp(`^${literal}/icon\\.png`));
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Terms · Particl");
  expect(await page.title()).toBe("Terms · Particl");

  await page.goto("/review/not-a-real-token");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /^data:image\/svg\+xml/);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).not.toHaveAttribute("content", /Particl/);
});
