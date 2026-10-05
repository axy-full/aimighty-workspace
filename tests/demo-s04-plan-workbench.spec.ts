import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * Board cards 1 · the plan card (design/particl-graphite/README.md § 3.1 e; lead decision 27), behind the
 * new-interface switch, on Atomik's durable Board run. The run is the real one on the local ENGINE_MOCK=1 server
 * (the scripted planner); nothing paid is ever sent. The card sits in the Storyboard group's open slot; Hold calls
 * nothing; Approve is the run's own approval by the person who asked, which builds (free); each render then waits
 * for its own tap at its own price, and the spec never takes it. Neutral names only.
 */
const SHOTS = process.env.S04_SHOTS || "/private/tmp/claude-s04-shots";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const beats = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: new Date().toISOString(),
  scenes: [{
    id: "scene-a", heading: "EXT. PIER - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
    shots: [
      { id: "shot-a1", description: "Mist over the water.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "", duration: 5 },
      { id: "shot-a2", description: "A figure on the pier.", framing: "Medium", movement: "Slow push · 35mm", lighting: "", sound: "", duration: 5 },
      { id: "shot-a3", description: "Her hands on the rope.", framing: "Close-up", movement: "Held · 85mm", lighting: "", sound: "", duration: 5 },
    ],
  }],
});
const shotNode = (id: string, title: string): CanvasNode => ({
  id, title, type: "scene", x: 400, y: 100, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

async function seed(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Plan Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const project: Project = {
    ...newProject("Pier film"), id: `plan-${Date.now().toString(36)}`, aspect: "16:9", fps: 24,
    brief: "A figure on a pier at dawn.", direction: "Soft mist, long lenses.", production: { beats: beats() },
    nodes: [shotNode("theirs", "Her opening")],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = await saved.json() as { productionProjectId: string };
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  /* Anything that would send paid work: a generation, a take's release, or an Atomik turn. Reads are fine. */
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || /\/release$/.test(path) || path.startsWith("/api/workbench/atomik"))) paid.push(path);
  });
  const post = (data: Record<string, unknown>) => page.request.post("/api/workbench/team-canvas", { headers, data: { productionId, ...data } });
  const agent = async () => (await (await page.request.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1`, { headers })).json()) as
    { agent: { run: { id: string; state: string; proposal: { fingerprint: string } | null; paid: { tool: string; state: string }[] } | null } };
  return { project, paid, post, agent };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the plan sits in the Storyboard group's open slot; Hold calls nothing; Approve builds, free; each render waits for its own tap", async ({ page }, info) => {
  const { project, paid, post, agent } = await seed(page);
  /* Atomik's thinking is a metered planning turn on the local mock; the person asks for the plan the same way Atomik's panel does. */
  const asked = await post({ action: "agent.plan", projectId: project.id, requestId: "req-plan-00000001", goal: "Two shots on the pier.", limit: 500 });
  expect(asked.status()).toBe(202);
  await expect.poll(async () => (await agent()).agent.run?.state, { timeout: 30_000 }).toBe("awaiting_approval");

  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  if (!desktop(page)) {
    /* Phone widths: the canvas is the desktop's (stream 10 draws the phone); here only the floors that hold at every width. */
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(paid).toEqual([]);
    return;
  }
  const slot = page.locator('[data-card-id="plan:run"]');
  const plan = slot.getByTestId("board-plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText("Make 2 shots");
  /* In the group's open slot: inside the Storyboard group's frame, after its frames. */
  const group = await page.locator('[data-card-id="group:storyboard"]').boundingBox();
  const at = await slot.boundingBox();
  expect(group && at && at.x >= group.x && at.y >= group.y && at.x + at.width <= group.x + group.width && at.y + at.height <= group.y + group.height).toBe(true);
  /* The button carries no figure the code does not spend: Approve builds (free); each render asks at its price. */
  await expect(plan.getByTestId("board-plan-primary")).toHaveText("Approve");
  await expect(plan.getByTestId("board-plan-hold")).toBeVisible();
  await expect(plan.getByTestId("board-plan-change")).toBeVisible();
  await expect(plan).toContainText("Each shot asks at its price before it renders.");
  await expect(plan).not.toContainText(/quoted/i);

  /* The steps are folded; unfolding grows the card in place and shows each render. A price the run has not got says so. */
  await expect(plan.getByTestId("board-plan-steps")).toHaveCount(0);
  await plan.getByTestId("board-plan-toggle").click();
  await expect(plan.getByTestId("board-plan-toggle")).toHaveText("Hide the steps");
  await expect(plan.getByTestId("board-plan-step")).toHaveCount(2);
  const planBox = await slot.boundingBox();
  const inside = await plan.boundingBox();
  expect(planBox && inside && inside.y + inside.height <= planBox.y + planBox.height + 1).toBe(true);
  await plan.getByTestId("board-plan-toggle").click();
  await expect(plan.getByTestId("board-plan-steps")).toHaveCount(0);

  /* Hold calls nothing: the card says so, Approve folds away, and Hold again brings it back. */
  await plan.getByTestId("board-plan-hold").click();
  await expect(plan).toContainText("On hold · nothing spent");
  await expect(plan.getByTestId("board-plan-primary")).toHaveCount(0);
  await plan.getByTestId("board-plan-hold").click();
  await expect(plan.getByTestId("board-plan-primary")).toBeVisible();
  /* Change hands the words to Atomik's panel, never sent. */
  await plan.getByTestId("board-plan-change").click();
  await expect(page.getByTestId("toast")).toContainText("Tell Atomik what to change");

  /* Readable dark: nothing on the card is under 12 px. */
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="board-plan"] *')]
    .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
  expect(small).toEqual([]);
  mkdirSync(SHOTS, { recursive: true });
  await page.getByTestId("board-rail").getByText("Storyboard", { exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/plan-proposal-${info.project.name.replace("workbench-", "")}.png` });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);

  /* Approve: the run builds (free). Its first render is then priced and waits for the person who asked. */
  await plan.getByTestId("board-plan-primary").click();
  await expect.poll(async () => (await agent()).agent.run?.state, { timeout: 45_000 }).toBe("needs_you");
  await expect(plan).toContainText("Making 2 shots", { timeout: 20_000 });
  await expect(plan.getByTestId("board-plan-primary")).toHaveText(/^Render · (up to )?[\d.,]+ cr$/);
  await expect(plan.getByTestId("board-plan-step").first()).toContainText("Ready");
  await expect(plan.getByTestId("board-plan-step").nth(1)).toContainText("Up next");
  await expect(plan.getByTestId("board-plan-hold")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/plan-approved-${info.project.name.replace("workbench-", "")}.png` });
  /* Nothing was rendered: the render waits for its own tap, which this spec never takes. */
  expect(paid).toEqual([]);
  expect((await agent()).agent.run!.paid.filter((p) => p.tool === "render" && p.state === "rendering")).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});
