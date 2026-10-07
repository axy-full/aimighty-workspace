import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { seedBoard, desktop } from "./helpers/s03-board";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTextIn } from "./helpers/s07Floors";

/*
 * Stream 7 · the board's docked Atomik panel (design/particl-graphite README § 3.1; Studio board frames a–p). Real local
 * ENGINE_MOCK=1 server: the board agent is today's scripted planner through the real tools. The ask's price is the
 * server's planning figure and is sent as the run's limit; the proposal is approved through the approvals queue;
 * after a thinking-only ask the renders wait on the run's limit (Raise), and a render is never pressed here. Neutral
 * names only. The canvas is desktop only (phones open the project's Record, stream 10).
 */
const SHOTS = process.env.S07_SHOTS || join(tmpdir(), "claude-s07-shots");
const shot = async (page: Page, name: string, info: { project: { name: string } }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace(/^workbench-/, "")}.png` });
};
const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no horizontal overflow").toBeLessThanOrEqual(1);

test("the dock: a rail that opens to Atomik, an ask at the server's price, a proposal approved through the queue", async ({ page }, info) => {
  test.skip(!desktop(page), "the board canvas is desktop only (phones open the project's Record, stream 10)");
  const { project, headers, productionId } = await seedBoard(page);
  await forbidPaidWork(page);
  const generated: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/(generate(?!\/quote)|jobs)/.test(new URL(r.url()).pathname)) generated.push(new URL(r.url()).pathname); });
  const asked: Record<string, unknown>[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/workbench/team-canvas") asked.push(r.postDataJSON() as Record<string, unknown>); });
  await page.goto(`/suites?project=${project.id}&view=board`);
  const dock = page.getByTestId("board-agent-dock");
  await expect(dock).toBeVisible();
  /* A board with a brief and no look yet opens the panel on its questions; collapse it to see the rail. */
  await expect(async () => {
    if ((await dock.getAttribute("data-open")) === "true") await dock.getByTestId("agent-collapse").click({ timeout: 3000 });
    await expect(dock).toHaveAttribute("data-open", "false", { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await expect(dock.getByTestId("agent-rail")).toContainText("Atomik");
  expect((await dock.boundingBox())!.width).toBe(56);
  await shot(page, "dock-rail", info);

  /* A cold dev server may reload the page once while it compiles the panel: open it again if so. */
  await expect(async () => {
    if ((await dock.getAttribute("data-open")) !== "true") await dock.getByTestId("agent-rail").click({ timeout: 3000 });
    await expect(dock).toHaveAttribute("data-open", "true", { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  expect(Math.round((await dock.boundingBox())!.width)).toBe(340);
  const panel = page.getByTestId("board-agent-panel");
  await expect(panel.getByTestId("agent-idle")).toContainText("I plan first and show the price");
  /* The ask's figure is the code's planning figure for this board now: the same one the server's read gives. */
  const read = await (await page.request.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1&projectId=${project.id}`, { headers })).json() as { agent: { ask: { planning: number } } };
  const planning = read.agent.ask.planning;
  await expect(panel.getByTestId("agent-ask")).toHaveText(/^Ask · up to [\d.,]+ cr$/);
  await expect(panel.getByTestId("agent-ask")).toHaveAttribute("data-spend-price", /^up to [\d.,]+ cr$/);
  await expect(panel.getByTestId("agent-ask")).toBeDisabled();
  await panel.getByTestId("agent-input").fill("Two shots of the market opening at dawn.");
  await expect(panel.getByTestId("agent-ask")).toBeEnabled();
  expect(await smallTextIn(page, ".ag"), "text under 12 px").toEqual([]);
  await noSideways(page);
  await shot(page, "dock-ask", info);
  await panel.getByTestId("agent-ask").click();
  /* The price on the button is the approval: the run is asked with that figure as its limit. */
  await expect.poll(() => asked.find((a) => a.action === "agent.plan")?.limit ?? null).toBe(planning);
  expect(asked.find((a) => a.action === "agent.plan")).toMatchObject({ mode: "ask" });

  /* The proposal: free; Build · free is the queue's approval for this run. */
  const proposal = panel.getByTestId("agent-proposal");
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("agent-count")).toContainText("· free");
  await expect(panel.getByTestId("agent-build")).toHaveText("Build · free");
  await expect(panel.getByTestId("agent-build")).toBeEnabled({ timeout: 20_000 });
  expect(await smallTextIn(page, ".ag"), "text under 12 px").toEqual([]);
  await shot(page, "dock-proposal", info);
  await panel.getByTestId("agent-build").click();
  /* Plan approval (owner decisions L4/L5): after Build the renders wait behind ONE gate, the plan at its total, approved on the board's plan card.
     The panel lists each render at its price as Ready with no Render button of its own (the queue holds the plan, not its steps), and the
     card's Approve · N cr is the approval, at the sum of those prices. It is shown here and never pressed. */
  const lines = panel.getByTestId("agent-render-state");
  await expect(lines.first()).toHaveText("Ready", { timeout: 60_000 });
  await expect(panel.getByTestId("agent-render")).toHaveCount(0);
  await expect(panel.getByTestId("agent-skip")).toHaveCount(0);
  const card = page.getByTestId("board-plan");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("board-plan-primary")).toHaveText(/^Approve · [\d.,]+ cr$/);
  await expect(card.getByTestId("board-plan-primary")).toHaveAttribute("data-spend", "priced");
  expect(await smallTextIn(page, ".ag"), "text under 12 px").toEqual([]);
  await shot(page, "dock-render", info);
  /* Undo the build; collapse back to the rail. */
  await panel.getByTestId("agent-undo").click();
  await expect(panel.getByTestId("agent-undone")).toBeVisible({ timeout: 30_000 });
  await panel.getByTestId("agent-collapse").click();
  await expect(dock).toHaveAttribute("data-open", "false");
  /* Nothing was rendered from here. */
  expect(asked.filter((a) => a.action === "agent.render")).toEqual([]);
  expect(generated).toEqual([]);
});
