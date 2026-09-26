import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { handoffKey } from "../lib/composeHandoff";
import { DESKTOP, forbidPaid, projectWithShots } from "./helpers/appPagesAudit";

/**
 * The app-pages audit, in a real browser against a local ENGINE_MOCK=1 server:
 * The shot builder's hand-off, the entry points, Workspace › Engines and the platform desk, and public metadata. Nothing here submits paid work. The audit is split across files so
 * each CI shard's dev server compiles only some of these pages.
 */

test("the shot builder hands its subject line to Generate and keeps the picks", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "One hand-off pass.");
  await forbidPaid(page);
  await signInLocally(page.request);
  /* Generate composes into a saved Studio project, remembered for this workspace and person. */
  const production = await projectWithShots(page);
  const me = await (await page.request.get("/api/me")).json();
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const saved = { ...newProject("Hand-off film"), productionProjectId: production.id };
  const put = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project: saved, revision: 0 } });
  expect(put.ok(), await put.text()).toBe(true);
  /* The builder is scoped to that production, and Generate remembers no project: only the builder's own lookup can open the right one. */
  await page.addInitScript((production) => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("aw_project", production); sessionStorage.setItem("seeded", "1"); } }, production.id);

  await page.goto("/studio/shot");
  await expect(page.getByRole("navigation", { name: "Studio" }).getByRole("link", { name: "Cast", exact: true })).toHaveAttribute("href", "/suites?suite=particl&page=cast");
  /* The drafts are kept per project selection; let it settle before typing. */
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByLabel("Subject line").fill("A courier runs through the rain");
  await page.getByRole("button", { name: "Open in Generate" }).click();
  /* Opened on this production's own Studio project. */
  await expect(page).toHaveURL(new RegExp(`/generate\\?mode=video&project=${saved.id}`));
  await expect.poll(() => page.locator("textarea").evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value).join("\n"))).toContain("A courier runs through the rain");
  /* Taken once: a second visit to Generate does not paste it again. */
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("particl:compose-handoff")).length)).toBe(0);
  await page.goto("/studio/shot");
  await expect(page.getByLabel("Subject line")).toHaveValue("A courier runs through the rain");

  /* Words written for another production wait rather than render, bill and file here. */
  await page.evaluate(({ key, at }) => sessionStorage.setItem(key, JSON.stringify({ prompt: "A second courier", kind: "video", at, productionProjectId: "prj_elsewhere" })), { key: handoffKey(me.workspace.id, me.email), at: Date.now() });
  await page.goto(`/generate?mode=video&project=${saved.id}`);
  await expect(page.getByText("Your Setup is for another production. Choose its project to use it.")).toBeVisible();
  expect(await page.locator("textarea").evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value).join("\n"))).not.toContain("A second courier");
});

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
