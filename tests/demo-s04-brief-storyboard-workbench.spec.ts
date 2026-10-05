import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { smallTargets, smallText } from "./phoneFloors";
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
  /* Frame d: the brief beside its storyboard. */
  await page.getByTestId("board-rail").getByText("Brief", { exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/brief-storyboard-${info.project.name.replace("workbench-", "")}.png` });
});

test("the brief is edited in place and saves itself", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only (phone widths open the project's Record, stream 10)");
  const { project, scope, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const text = page.locator('[data-card-id="doc:brief"]').getByTestId("board-brief-text");
  await expect(text).toBeVisible();
  /* The board opens on the section that needs you; a click on Brief in the rail glides to it. */
  await page.getByTestId("board-rail").getByText("Brief", { exact: true }).click();
  await page.waitForTimeout(600);
  await text.click();
  await text.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await text.pressSequentially(" The sun clears the ridge.");
  await expect.poll(async () => {
    const read = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } });
    return ((await read.json()) as { project: Project | null }).project?.brief ?? "";
  }, { timeout: 15_000 }).toBe("A runner meets the dawn on an empty hillside. The sun clears the ridge.");
  await page.reload();
  await expect(page.locator('[data-card-id="doc:brief"]').getByTestId("board-brief-text")).toHaveValue("A runner meets the dawn on an empty hillside. The sun clears the ridge.");
  expect(paid).toEqual([]);
});

test("the List view is the shot list: its rows are edited in place, a shot is added, and each edit saves itself", async ({ page }, info) => {
  const { project, scope, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board&list=1`);
  const list = page.getByTestId("board-shotlist");
  await expect(list).toBeVisible();
  if (!desktop(page)) {
    /* Phone widths: each shot stacks; every target is 44 px, nothing is under 12 px, and nothing runs past the edge. */
    await expect(list.getByTestId("board-shotlist-row")).toHaveCount(3);
    expect(await smallTargets(page, '[data-testid="board-shotlist"]')).toEqual([]);
    expect(await smallText(page, ".bd-rail, .gx-header")).toEqual([]);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    /* At the end of the list, the last control sits above the tab bar and the safe area. */
    const clear = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".bd--compact");
      const add = document.querySelector<HTMLElement>('[data-testid="board-shotlist-add"]');
      const bar = document.querySelector<HTMLElement>('[data-testid="tabbar"]');
      if (!scroller || !add) return { ok: false, why: "no scroller or add button" };
      scroller.scrollTop = scroller.scrollHeight;
      const r = add.getBoundingClientRect();
      const t = bar ? bar.getBoundingClientRect() : null;
      /* The bar is at the bottom of a portrait phone and at the side of a landscape one: no overlap either way. */
      const overlaps = !!t && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
      return { ok: !overlaps && r.bottom <= window.innerHeight, why: `add at ${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)}; bar ${t ? `${Math.round(t.left)},${Math.round(t.top)}–${Math.round(t.right)},${Math.round(t.bottom)}` : "none"}` };
    });
    expect(clear.ok, clear.why).toBe(true);
    expect(paid).toEqual([]);
    await page.screenshot({ path: `${SHOTS}/shot-list-${info.project.name.replace("workbench-", "")}.png` });
    return;
  }
  const rows = list.getByTestId("board-shotlist-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("0:00");
  await expect(rows.nth(1).getByLabel("Shot 2 action")).toHaveValue("A runner crests the hill.");
  await expect(rows.nth(2).getByLabel("Shot 3 size")).toHaveValue("Close-up");
  /* State, until the Shots cards say more: planned (no frame yet). */
  await expect(rows.nth(0).getByTestId("board-shotlist-state")).toHaveText("Planned");

  const action = rows.nth(1).getByLabel("Shot 2 action");
  await action.click();
  await action.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await action.pressSequentially(" The valley opens below.");
  const beatsOf = async () => {
    const read = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } });
    const saved = ((await read.json()) as { project: Project | null }).project;
    return (saved?.production?.beats?.scenes ?? []).flatMap((s) => s.shots);
  };
  await expect.poll(async () => (await beatsOf())[1]?.description, { timeout: 15_000 }).toBe("A runner crests the hill. The valley opens below.");

  const seconds = rows.nth(0).getByLabel("Shot 1 length in seconds");
  await seconds.fill("5");
  await seconds.press("Enter");
  await expect.poll(async () => (await beatsOf())[0]?.duration, { timeout: 15_000 }).toBe(5);
  await expect(rows.nth(1)).toContainText("0:05");

  await list.getByTestId("board-shotlist-add").click();
  await expect(rows).toHaveCount(4);
  await expect.poll(async () => (await beatsOf()).length, { timeout: 15_000 }).toBe(4);

  /* Taking a shot out is undone with ⌘Z (the shell's stack); the row comes back where it was. */
  await rows.nth(3).getByRole("button", { name: /Take shot 4 out/ }).click();
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("toast")).toContainText("Shot 4 taken out");
  await page.locator("body").click({ position: { x: 700, y: 600 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows).toHaveCount(4);

  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="board-shotlist"] *')]
    .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
  expect(small).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/shot-list-${info.project.name.replace("workbench-", "")}.png` });
});
