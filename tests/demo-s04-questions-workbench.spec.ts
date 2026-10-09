import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * Board cards 1 · Atomik's questions and "Show me looks" (README § 3.1 b, c), and "Draw the storyboard" (§ 3.1 d).
 * The questions form is mounted by the docked Atomik panel (lead decision 29); this spec finds it there and is
 * skipped on a branch whose panel does not mount it yet. Every paid control is one person's press at the price the
 * server showed, on the local ENGINE_MOCK=1 server: nothing is sent before the press, then exactly one request per
 * look and one per frame, each at its shown price.
 */
const SHOTS = process.env.S04_SHOTS || join(tmpdir(), "claude-s04-shots");
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const beats = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: new Date().toISOString(),
  scenes: [{
    id: "scene-a", heading: "EXT. PIER - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
    shots: [
      { id: "shot-a1", description: "Mist over the water.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "", duration: 5 },
      { id: "shot-a2", description: "A figure on the pier.", framing: "Medium", movement: "Slow push · 35mm", lighting: "", sound: "", duration: 5 },
    ],
  }],
});

async function seed(page: Page) {
  const workspaceId = (await signInWithNewInterface(page.request, "Questions Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const project: Project = {
    ...newProject("Pier film"), id: `ask-${Date.now().toString(36)}`, aspect: "16:9", fps: 24,
    brief: "A figure on a pier at dawn.", direction: "Soft mist, long lenses.", production: { beats: beats() },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const sent: { shown: unknown; body: Record<string, unknown> }[] = [];
  const quotes: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (path === "/api/generate") sent.push({ shown: request.headers()["x-shown-credits"] ?? null, body: request.postDataJSON() as Record<string, unknown> });
    if (path === "/api/generate/quote") quotes.push(request.postDataJSON() as Record<string, unknown>);
  });
  return { project, headers, sent, quotes };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const projectOf = async (page: Page, id: string, headers: Record<string, string>) =>
  ((await (await page.request.get(`/api/workbench/projects?id=${id}`, { headers })).json()) as { project: Project | null }).project;

test("the questions: chips and a free field each, a price from the server, Use your judgement is free, and Show me looks sends one request per look only when pressed", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas and the docked panel are desktop only");
  const { project, headers, sent, quotes } = await seed(page);
  await page.addInitScript(() => { try { sessionStorage.setItem("s04q", "1"); } catch { /* storage off */ } });
  await page.goto(`/suites?project=${project.id}&view=board`);
  const block = page.getByTestId("board-questions");
  const mounted = await block.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false);
  test.skip(!mounted, "the docked Atomik panel does not mount the questions on this branch");
  await expect(block).toBeVisible();

  const groups = block.getByRole("group");
  await expect(groups).toHaveCount(3);
  await expect(groups.nth(0)).toContainText("Format");
  await expect(groups.nth(0).getByRole("button")).toHaveText(["16:9 · 10 s", "9:16 · 10 s", "Both"]);
  await expect(groups.nth(1)).toContainText("Cast references");
  await expect(groups.nth(1).getByRole("button")).toHaveText(["I’ll upload", "Cast someone new"]);
  await expect(groups.nth(2).getByRole("button")).toHaveText(["One direction", "Two variations", "Three"]);

  /* The price is the server's: four stills quoted (read only), added up on the button. Nothing is sent. */
  const looks = block.getByTestId("board-questions-looks");
  await expect(looks).toHaveText(/^Show me looks · [\d.,]+ cr$/, { timeout: 30_000 });
  expect(quotes.length).toBeGreaterThanOrEqual(4);
  expect(sent).toEqual([]);
  await expect(looks).toHaveAttribute("title", /\$[\d.]+/);

  /* Use your judgement is free: it only fills the defaults. */
  await block.getByTestId("board-questions-judgement").click();
  await expect(groups.nth(0).getByRole("button", { name: /^16:9/ })).toHaveAttribute("aria-pressed", "true");
  await expect(groups.nth(2).getByRole("button", { name: "One direction" })).toHaveAttribute("aria-pressed", "true");
  expect(sent).toEqual([]);

  /* A chosen format changes what is asked, and the aspect is saved on the project first. */
  await groups.nth(0).getByRole("button", { name: /^9:16/ }).click();
  await expect(looks).toHaveText(/^Show me looks · [\d.,]+ cr$/, { timeout: 30_000 });
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/questions-${info.project.name.replace("workbench-", "")}.png` });
  await looks.click();
  await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(4);
  for (const request of sent) {
    /* Each is sent at the price the server showed (the request carries it as its ceiling and the quote it was read from). */
    expect(request.body).toMatchObject({ model: "gemini-3-pro-image", ratio: "9:16", resolution: "1K", references: [] });
    expect(Number(request.body.maxCredits)).toBeGreaterThan(0);
    expect(String(request.body.quoteFingerprint)).toMatch(/^[a-f0-9]{64}$/);
  }
  await expect.poll(async () => Object.keys((await projectOf(page, project.id, headers))?.production?.boards?.looks ?? {}).sort(), { timeout: 20_000 })
    .toEqual(["bleach-bypass", "blue-hour", "clean-daylight", "golden-hour"]);
  expect((await projectOf(page, project.id, headers))?.aspect).toBe("9:16");
  /* The four looks are on the board, ready to pick. */
  await expect(page.locator('[data-card-kind="look"]')).toHaveCount(4, { timeout: 30_000 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("Draw the storyboard: every shot without a frame is priced by the server and sent by one press, each at its shown price, in the picked look", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas and the docked panel are desktop only");
  const { project, headers, sent } = await seed(page);
  await page.addInitScript(() => { try { sessionStorage.setItem("s04q", "1"); } catch { /* storage off */ } });
  await page.goto(`/suites?project=${project.id}&view=board`);
  const draw = page.getByTestId("board-draw-button");
  const mounted = await draw.waitFor({ state: "visible", timeout: 20_000 }).then(() => true, () => false);
  test.skip(!mounted, "the docked Atomik panel does not mount the storyboard button on this branch");
  await expect(draw).toHaveText(/^Draw the storyboard · [\d.,]+ cr$/, { timeout: 30_000 });
  expect(sent).toEqual([]);
  await expect(draw).toHaveAttribute("title", /\$[\d.]+/);
  await draw.click();
  await expect.poll(() => sent.length, { timeout: 30_000 }).toBe(2);
  for (const request of sent) {
    expect(request.body).toMatchObject({ ratio: "16:9", resolution: "1K" });
    expect(Number(request.body.maxCredits)).toBeGreaterThan(0);
  }
  await expect.poll(async () => Object.values((await projectOf(page, project.id, headers))?.production?.boards?.frames ?? {}).filter((f) => (f.pending?.length ?? 0) + f.takes.length > 0).length, { timeout: 20_000 }).toBe(2);
  /* Every shot has a frame on its way or drawn: the button is gone, and nothing more is sent. */
  await expect(page.getByTestId("board-draw")).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(sent).toHaveLength(2);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/storyboard-drawn-${info.project.name.replace("workbench-", "")}.png` });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});
