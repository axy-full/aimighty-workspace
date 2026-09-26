import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { DESKTOP } from "./helpers/appPagesAudit";

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
    await visitor.goto("/generate?mode=images&task=upscale");
    const signIn = visitor.getByRole("link", { name: "Sign in" }).first();
    await expect(signIn).toHaveAttribute("href", `/login?next=${encodeURIComponent("/generate?mode=images&task=upscale")}`);
  } finally {
    await visitor.close();
  }

  await signInLocally(page.request);
  /* The switch is the response itself — a 307 — not a 200 carrying a meta refresh. */
  for (const [entry, target] of [["/", /^\/suites\?suite=particl/], ["/atomik", /^\/suites\?suite=atomik/], ["/subatomik", /^\/suites\?suite=subatomik/], ["/workbench", /^\/suites\?suite=particl/]] as const) {
    const res = await page.request.get(entry, { maxRedirects: 0 });
    expect(res.status(), entry).toBe(307);
    expect(res.headers().location, entry).toMatch(target);
  }
  /* The other (app) redirect pages answer the same way now that the shell streams no boundary. */
  const moved = await page.request.get("/images", { maxRedirects: 0 });
  expect(moved.status()).toBe(307);
  const response = await page.goto("/workbench?stage=brief");
  expect(response?.request().redirectedFrom()?.url()).toContain("/workbench?stage=brief");
  await expect(page).toHaveURL(/\/suites\?suite=particl&page=brief/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/suites\?suite=particl/);
  await expect(page.getByTestId("switchover-note")).toHaveCount(0);
});

test("Suites Workspace › Engines links the token page; the platform desk is for the platform owner only", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Links, once.");
  await signInLocally(page.request);
  await page.goto("/suites?view=workspace&tab=engines");
  const connect = page.getByTestId("workspace-connect-link");
  await expect(connect).toHaveAttribute("href", "/connect");
  await expect(connect).toContainText("No tokens yet");
  await page.getByRole("tab", { name: "General" }).click();
  await expect(page.getByTestId("platform-desk")).toHaveCount(0);
});

test("public metadata: robots, sitemap, one icon per URL, and client review pages without Particl's install card", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Metadata, once.");
  const robots = await (await page.request.get("/robots.txt")).text();
  for (const path of ["/api/", "/invite/", "/reset/"]) expect(robots).toContain(`Disallow: ${path}`);
  /* A review link may be fetched for its preview card; noindex (meta and header) keeps it out of every index. */
  expect(robots).not.toContain("Disallow: /review/");
  expect((await page.request.get("/review/not-a-real-token")).headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect((await page.request.get("/terms")).headers()["x-robots-tag"]).toBeUndefined();
  expect(robots).toContain("Sitemap: http://localhost:4803/sitemap.xml");
  expect(await (await page.request.get("/sitemap.xml")).text()).toContain("<loc>http://localhost:4803/terms</loc>");
  const icon = await page.request.get("/icon.png");
  expect(createHash("sha1").update(await icon.body()).digest("hex")).toBe(createHash("sha1").update(readFileSync("public/icon.png")).digest("hex"));

  await page.goto("/terms");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /^http:\/\/localhost:4803\/icon\.png/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Terms · Particl");
  expect(await page.title()).toBe("Terms · Particl");

  await page.goto("/review/not-a-real-token");
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /^data:image\/svg\+xml/);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).not.toHaveAttribute("content", /Particl/);
});
