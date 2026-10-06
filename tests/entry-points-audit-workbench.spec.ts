import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { DESKTOP } from "./helpers/appPagesAudit";
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
  /* The chain is two 307s (/workbench → /suites?suite=particl&page=brief → the board), and Playwright's redirectedFrom() is one hop back: walk it to the request the person made. */
  let first = response?.request();
  for (let hop = first?.redirectedFrom(); hop; hop = first?.redirectedFrom()) first = hop;
  expect(first?.url()).toContain("/workbench?stage=brief");
  /* The Studio's Brief page is deleted: the old stage address ends on the board's Brief region (one more 307 inside /suites). */
  await expect(page).toHaveURL(/\/suites\?(?=.*view=board)(?=.*region=brief)/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/suites\?suite=particl/);
  await expect(page.getByTestId("switchover-note")).toHaveCount(0);
});

test("Suites Workspace › Engines links Settings › Connections; the platform desk is for the platform owner only", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "Links, once.");
  await signInLocally(page.request);
  await page.goto("/suites?view=workspace&tab=engines");
  const connect = page.getByTestId("workspace-connect-link");
  await expect(connect).toHaveAttribute("href", "/suites?view=workspace&tab=connections");
  await expect(connect).toContainText("No tokens yet");
  await page.getByRole("tab", { name: "General" }).click();
  await expect(page.getByTestId("platform-desk")).toHaveCount(0);
});

test("on a phone, the tokens row is the last card on Engines and ends above the tab bar", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-390x844"].includes(info.project.name), "the phones with a pinned tab bar");
  await signInLocally(page.request);
  /* The Higgsfield sign-in is off for Release 1: Engines has no connected-account row and never reads the account. */
  const accountReads: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/higgsfield/consumer/")) accountReads.push(request.url()); });
  await page.goto("/suites?view=workspace&tab=engines");
  /* Everything above it has loaded, so nothing moves it after the measure. */
  await expect(page.getByTestId("ws-engine").first()).toBeVisible();
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  expect(accountReads).toEqual([]);
  /* The developer-API check went with the Higgsfield sign-in. */
  await expect(page.getByTestId("engine-developer-api")).toHaveCount(0);
  await expect(page.getByTestId("workspace-connect-link")).toContainText(/token/);
  const end = () => page.getByTestId("workspace-view").evaluate(async (pane) => {
    pane.scrollTop = pane.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const row = pane.querySelector<HTMLElement>('[data-testid="engine-connect"]')!;
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    const pinned = bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed";
    return { last: row.parentElement?.lastElementChild === row, gap: pinned ? Math.round((bar.getBoundingClientRect().top - row.getBoundingClientRect().bottom) * 100) / 100 : null };
  });
  expect((await end()).last, "the tokens row is the tab's last card").toBe(true);
  await expect.poll(async () => (await end()).gap, { message: "at the pane's end, the tokens row ends above the pinned tab bar" }).toBeGreaterThanOrEqual(0);
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
