import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * Board cards 1 · the plan card (design/particl-graphite/README.md § 3.1 e; CLAUDE.md rule 14: a plan is approved
 * once), on Atomik's durable Board run. The run is the real one on the local ENGINE_MOCK=1 server (the scripted
 * planner); nothing paid is ever sent. The card sits in the Storyboard group's open slot; Hold calls nothing;
 * Build · free builds the board; then the server prices every render and the card is the plan gate,
 * "Make 2 shots · N cr · at most 2N cr" with the price as the button. The spec never presses it. Neutral names only.
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

test("the plan sits in the Storyboard group's open slot; Hold calls nothing; Build is free; then the server's total is the button", async ({ page }, info) => {
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
  /* Building spends nothing and approves no spending: the shots are priced once they are on the board. */
  await expect(plan.getByTestId("board-plan-primary")).toHaveText("Build · free");
  /* Building spends nothing: Build carries no spend marker. */
  await expect(plan.getByTestId("board-plan-primary")).not.toHaveAttribute("data-spend", /.*/);
  await expect(plan.getByTestId("board-plan-hold")).toBeVisible();
  await expect(plan.getByTestId("board-plan-change")).toBeVisible();
  await expect(plan).toContainText("One approval covers the shots and up to 2 fixes each; anything else asks.");
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

  /* Build: the run builds (free). Then every render is priced by the server, and the card is the plan gate. */
  await plan.getByTestId("board-plan-primary").click();
  await expect.poll(async () => (await agent()).agent.run?.state, { timeout: 45_000 }).toBe("needs_you");
  const quote = async () => ((await agent()).agent.run as unknown as { plan?: { quote?: { total: number; ceiling: number } | null } }).plan?.quote ?? null;
  await expect.poll(async () => (await quote())?.total ?? null, { timeout: 20_000 }).not.toBeNull();
  const { total, ceiling } = (await quote())!;
  const cr = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} cr`;
  /* The card's figures are the server's: the title, and the price as the button. */
  await expect(plan).toContainText(`Make 2 shots · ${cr(total)} · at most ${cr(ceiling)}`, { timeout: 20_000 });
  await expect(plan.getByTestId("board-plan-primary")).toHaveText(`Approve · ${cr(total)}`);
  /* The plan's Approve spends: it carries its price marker. */
  await expect(plan.getByTestId("board-plan-primary")).toHaveAttribute("data-spend", "priced");
  await expect(plan.getByTestId("board-plan-step")).toHaveCount(2);
  await expect(plan.getByTestId("board-plan-step").first().locator(".gx-price")).toHaveText(/^(up to )?[\d.,]+ cr$/);
  await expect(plan.getByTestId("board-plan-hold")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/plan-gate-${info.project.name.replace("workbench-", "")}.png` });
  /* Nothing was rendered: the plan waits for its one approval, which this spec never gives. */
  expect(paid).toEqual([]);
  expect((await agent()).agent.run!.paid.filter((p) => p.tool === "render" && p.state === "rendering")).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

/* ── The priced plan (frame e's numbers), on a run the browser answers: no planner, no engine ───────────────────── */

const FP = "a".repeat(64);
const step = (seq: number, title: string) => ({
  seq, tool: "render", title, state: "next", quote: null, worst: null, pause: null, charged: null, outcome: null, charge: null, reason: null, canRender: false, fingerprint: null,
});
const proposal = (limit: number, left: number) => ({
  id: "rar_000000000000000000000001", state: "awaiting_approval", reason: null, goal: "Three shots", mine: true,
  proposal: { title: "Three shots", summary: "", groups: [], cards: 0, wires: 0, tidy: false, next: [], fingerprint: FP },
  steps: [], built: { cards: 0, wires: 0 }, held: [], undo: null, canUndo: false, credits: 14,
  money: { mode: "ask", limit, jobCeiling: 200, spent: 14, inFlight: 0, left, planning: { state: "settled", credits: 14 } },
  paid: [step(1, "Opening"), step(2, "The turn"), step(3, "Close")], at: Date.now(),
});
const sceneNode = (id: string, title: string, boardShotId: string, engine: string, x: number): CanvasNode => ({
  id, title, type: "scene", x, y: 100, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", engine, durationS: 5, ratio: "16:9", resolution: "1080p", boardShotId, text: `${title}.`,
});

async function priced(page: Page, run: ReturnType<typeof proposal>, prices: [number, number, number], balance?: number) {
  const workspaceId = (await signInLocally(page.request, "Priced Plan Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const SEED = "dreamina-seedance-2-5-260628", KLING = "fal-ai/kling-video/v3/standard";
  const project: Project = {
    ...newProject("Pier film"), id: `priced-${Date.now().toString(36)}`, aspect: "16:9", fps: 24, brief: "A figure on a pier at dawn.", direction: "Soft mist.",
    production: { beats: beats() },
    nodes: [sceneNode("node-shot0001", "Opening", "shot-a1", SEED, 0), sceneNode("node-shot0002", "The turn", "shot-a2", SEED, 300), sceneNode("node-shot0003", "Close", "shot-a3", KLING, 600)],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  for (const n of project.nodes) expect((await page.request.post("/api/workbench/projects", { headers, data: { projectId: project.id, action: "map-shot", nodeId: n.id } })).ok()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const posts: Record<string, unknown>[] = [];
  const paid: string[] = [];
  await page.route(/\/api\/workbench\/team-canvas(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("agent") === "1")
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: { enabled: true, run, ask: null } }) });
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (typeof body.action === "string" && body.action.startsWith("agent.")) {
        posts.push(body);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: { enabled: true, run: { ...run, state: "running" } } }) });
      }
    }
    return route.continue();
  });
  /* The server's quote for each shot's own request: Seedance 2.5 at 43 cr a take, Kling at 7 (the master's rows). */
  await page.route("**/api/generate/quote", async (route) => {
    const body = route.request().postDataJSON() as { model?: { id?: string } | string };
    const id = typeof body.model === "string" ? body.model : body.model?.id;
    const credits = id === KLING ? prices[2] : prices[0];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ estimatedCredits: credits, fingerprint: "q".repeat(64) }) });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || /\/release$/.test(path))) paid.push(path);
  });
  void balance;
  return { project, posts, paid };
}

test("a priced proposal: three shots at the server's prices, 93 cr for them, at most 186 cr with fixes, the balance after; Build · free sends the run's own approval of the build and nothing else", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, posts, paid } = await priced(page, proposal(500, 486), [43, 43, 7]);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const plan = page.locator('[data-card-id="plan:run"]').getByTestId("board-plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText("Make 3 shots");
  await expect(plan.getByTestId("board-plan-line")).toContainText("93 cr for the 3 shots");
  await expect(plan.getByTestId("board-plan-line")).toContainText("Fixes if needed: up to 2 per shot, within 186 cr");
  await expect(plan.getByTestId("board-plan-line")).toContainText(/\d[\d,]* cr left after/);
  /* Building approves no spending: the button carries no figure. */
  await expect(plan.getByTestId("board-plan-primary")).toHaveText("Build · free");
  await expect(plan.getByTestId("board-plan-primary")).toBeEnabled();
  await plan.getByTestId("board-plan-toggle").click();
  const rows = plan.getByTestId("board-plan-step");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Opening");
  await expect(rows.nth(0)).toContainText("Seedance 2.5 · 5 s · 480p draft");
  await expect(rows.nth(0).locator(".gx-price")).toHaveText("43 cr");
  await expect(rows.nth(2).locator(".gx-price")).toHaveText("7 cr");
  await expect(rows.nth(0).locator(".gx-price")).toHaveAttribute("title", /^\$[\d.]+$/);
  await page.screenshot({ path: `${SHOTS}/plan-priced-${info.project.name.replace("workbench-", "")}.png` });
  expect(posts).toEqual([]);
  await plan.getByTestId("board-plan-toggle").click();
  await plan.getByTestId("board-plan-primary").click();
  /* The run's own approval of the build, on the proposal as shown: its fingerprint. Never a limit from the browser. */
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ action: "agent.approve", runId: "rar_000000000000000000000001", fingerprint: FP });
  expect(posts.some((p) => p.action === "agent.limit")).toBe(false);
  expect(paid).toEqual([]);
});

/** The plan gate as the server answers it: built, each render priced, the quote waiting for the one approval. */
const QUOTE_FP = "c".repeat(64);
const gate = (prices: [number, number, number]) => {
  const total = prices.reduce((a, b) => a + b, 0);
  const base = proposal(500, 486);
  return {
    ...base, state: "needs_you", reason: "Opening is ready to render · about 43 cr.",
    paid: base.paid.map((p, i) => ({ ...p, state: "waiting", quote: prices[i], worst: prices[i], canRender: true, fingerprint: FP })),
    plan: { quote: { total, ceiling: 2 * total, approximate: false, fingerprint: QUOTE_FP, covered: [1, 2, 3], asks: [] }, blocked: null, approval: null },
  };
};

test("the plan gate: Make 3 shots · 93 cr · at most 186 cr, the server's figures; Approve · 93 cr sends the plan's approval with its quote, never a limit", async ({ page }, info) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  /* The browser's own quotes would say otherwise (1 cr each): the card shows the server's plan quote. */
  const { project, posts, paid } = await priced(page, gate([43, 43, 7]) as unknown as ReturnType<typeof proposal>, [1, 1, 1]);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const plan = page.locator('[data-card-id="plan:run"]').getByTestId("board-plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText("Make 3 shots · 93 cr · at most 186 cr");
  await expect(plan.getByTestId("board-plan-line")).toContainText("Fixes if needed: up to 2 per shot, within 186 cr");
  await expect(plan.getByTestId("board-plan-primary")).toHaveText("Approve · 93 cr");
  await expect(plan.getByTestId("board-plan-primary")).toHaveAttribute("data-spend-price", "93 cr");
  await expect(plan.getByTestId("board-plan-primary")).toHaveAttribute("title", /^\$[\d.]+$/);
  const rows = plan.getByTestId("board-plan-step");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).locator(".gx-price")).toHaveText("43 cr");
  await expect(rows.nth(2).locator(".gx-price")).toHaveText("7 cr");
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/plan-gate-priced-${info.project.name.replace("workbench-", "")}.png` });
  await plan.getByTestId("board-plan-primary").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({ productionId: expect.any(String), action: "agent.approvePlan", runId: "rar_000000000000000000000001", fingerprint: QUOTE_FP });
  expect(paid).toEqual([]);
});

test("a short balance at the plan gate: the card says by how much, offers Top up, and Approve waits", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  /* 3 × 120 cr is more than the local balance. */
  const { project, posts } = await priced(page, gate([120, 120, 120]) as unknown as ReturnType<typeof proposal>, [120, 120, 120]);
  await page.goto(`/suites?project=${project.id}&view=board`);
  const plan = page.locator('[data-card-id="plan:run"]').getByTestId("board-plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText(/Short by [\d.,]+ cr/);
  await expect(plan).toContainText("Top up, then approve. Nothing is spent until you do.");
  await expect(plan.getByRole("button", { name: "Top up" })).toBeVisible();
  await expect(plan.getByTestId("board-plan-primary")).toBeDisabled();
  await plan.getByRole("button", { name: "Top up" }).click();
  await expect(page).toHaveURL(/view=workspace&tab=credits/);
  expect(posts).toEqual([]);
});
