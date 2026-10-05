import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * Board cards 1 · the brief and the storyboard (design/particl-graphite/README.md § 3.1 d), behind the
 * new-interface switch. A production with a brief and a shot list opens as a board: the brief as a document
 * card, edited in place and saved by itself; the Storyboard group with a frame per shot, each with its name
 * and line. Nothing paid is sent. Neutral names only.
 */
const SHOTS = process.env.S04_SHOTS || "/private/tmp/claude-s04-shots";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const beats = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: new Date().toISOString(),
  scenes: [{
    id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
    shots: [
      { id: "shot-a1", description: "Fog lifts off the valley.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "", duration: 4 },
      { id: "shot-a2", description: "A runner crests the hill.", framing: "Medium push", movement: "Slow push · 35mm", lighting: "", sound: "", duration: 6 },
      { id: "shot-a3", description: "Her breath in the cold air.", framing: "Close-up", movement: "Held · 85mm", lighting: "", sound: "", duration: 5 },
    ],
  }],
});

async function seed(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Cards Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project: Project = {
    ...newProject("Hillside film"), aspect: "16:9", fps: 24,
    brief: "A runner meets the dawn on an empty hillside.", direction: "Cold light, long lenses, breath in the air.",
    production: { beats: beats() },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path.startsWith("/api/jobs") || path === "/api/workbench/team-canvas")) paid.push(path);
  });
  return { project, scope, paid };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the brief is a document card and the storyboard a frame per shot", async ({ page }, info) => {
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  if (!desktop(page)) {
    /* Phone widths: the canvas is the desktop's; here only the floors that hold at every width. */
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(paid).toEqual([]);
    return;
  }
  const brief = page.locator('[data-card-id="doc:brief"]');
  await expect(brief).toBeVisible();
  await expect(brief.getByText("Brief", { exact: true })).toBeVisible();
  await expect(brief.getByRole("heading", { name: "Hillside film" })).toBeVisible();
  await expect(brief.getByTestId("board-brief-text")).toHaveValue("A runner meets the dawn on an empty hillside.");
  await expect(brief.getByTestId("board-brief-look")).toHaveValue("Cold light, long lenses, breath in the air.");
  await expect(brief.getByTestId("board-brief-foot")).toHaveText("16:9 · 24 fps · 15 s");

  const group = page.locator('[data-card-id="group:storyboard"]');
  await expect(group).toBeVisible();
  await expect(group).toContainText("Storyboard");
  await expect(group).toContainText("3 shots · no frames yet");
  const frames = page.locator('[data-card-kind="frame"]');
  await expect(frames).toHaveCount(3);
  await expect(frames.nth(0)).toContainText("Shot 1 · Extreme wide");
  await expect(frames.nth(0)).toContainText("1 · 0:00 · 4 s · Locked off · 24mm");
  await expect(frames.nth(1)).toContainText("2 · 0:04 · 6 s · Slow push · 35mm");
  await expect(frames.nth(2)).toContainText("No frame yet");

  /* Readable dark: nothing people read on these cards is under 12 px. */
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-card-kind="doc"] *, [data-card-kind="frame"] *')]
    .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
  expect(small).toEqual([]);

  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/brief-storyboard-${info.project.name.replace("workbench-", "")}.png` });
});

test("the brief is edited in place and saves itself", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only (phone widths open the project's Record, stream 10)");
  const { project, scope, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const text = page.locator('[data-card-id="doc:brief"]').getByTestId("board-brief-text");
  await expect(text).toBeVisible();
  await text.click();
  await text.press("End");
  await text.pressSequentially(" The sun clears the ridge.");
  await expect.poll(async () => {
    const read = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } });
    return ((await read.json()) as { project: Project | null }).project?.brief ?? "";
  }, { timeout: 15_000 }).toBe("A runner meets the dawn on an empty hillside. The sun clears the ridge.");
  await page.reload();
  await expect(page.locator('[data-card-id="doc:brief"]').getByTestId("board-brief-text")).toHaveValue("A runner meets the dawn on an empty hillside. The sun clears the ridge.");
  expect(paid).toEqual([]);
});
