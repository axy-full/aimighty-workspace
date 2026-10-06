import { test, expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";
import { dimLabels, lastRowClearsPinned, smallTargets, smallText } from "./phoneFloors";

/**
 * Stream 10, PR 2: plan approval on the phone (design/particl-graphite/README.md § 3.6, frames B1–B3), behind the
 * new-interface switch. It reads stream 4's plan model on a run the browser answers (no planner, no engine). Before
 * the build: the three lines at the server's quote route's prices, the Total, the most with fixes, the balance, and
 * Build · free (`agent.approve`). At the plan gate (CLAUDE.md rule 14) the price is the button: Approve · 93 cr sends
 * `agent.approvePlan` with the server's quote fingerprint, never a limit. Hold calls nothing; a short balance offers
 * Top up and Approve waits. Nothing paid is ever sent. Neutral names only.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const SHOTS = process.env.S10_SHOTS;
const shot = async (page: Page, project: string, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project.replace("workbench-", "")}-${name}.png` }); };
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const FP = "a".repeat(64);
const RUN_ID = "rar_000000000000000000000001";

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
const step = (seq: number, title: string) => ({
  seq, tool: "render", title, state: "next", quote: null, worst: null, pause: null, charged: null, outcome: null, charge: null, reason: null, canRender: false, fingerprint: null,
});
const proposal = (limit: number, left: number) => ({
  id: RUN_ID, state: "awaiting_approval", reason: null, goal: "Three shots", mine: true,
  proposal: { title: "Three shots", summary: "", groups: [], cards: 0, wires: 0, tidy: false, next: [], fingerprint: FP },
  steps: [], built: { cards: 0, wires: 0 }, held: [], undo: null, canUndo: false, credits: 14,
  money: { mode: "ask", limit, jobCeiling: 200, spent: 14, inFlight: 0, left, planning: { state: "settled", credits: 14 } },
  paid: [step(1, "Opening"), step(2, "The turn"), step(3, "Close")], at: Date.now(),
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
  } as unknown as ReturnType<typeof proposal>;
};
const sceneNode = (id: string, title: string, boardShotId: string, engine: string, x: number): CanvasNode => ({
  id, title, type: "scene", x, y: 100, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", engine, durationS: 5, ratio: "16:9", resolution: "1080p", boardShotId, text: `${title}.`,
});

async function open(page: Page, run: ReturnType<typeof proposal>, prices: [number, number, number], query = "screen=plan") {
  const workspaceId = (await signInWithNewInterface(page.request, "Phone Plan Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const SEED = "dreamina-seedance-2-5-260628", KLING = "fal-ai/kling-video/v3/standard";
  const project: Project = {
    ...newProject("Pier film"), id: `phone-plan-${Date.now().toString(36)}`, aspect: "16:9", fps: 24, brief: "A figure on a pier at dawn.", direction: "Soft mist.",
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
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: { enabled: true, run: posts.some((p) => p.action === "agent.approve" || p.action === "agent.approvePlan") ? { ...run, state: "running" } : run, ask: null } }) });
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (typeof body.action === "string" && body.action.startsWith("agent.")) {
        posts.push(body);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: { enabled: true, run: { ...run, state: "running" } } }) });
      }
    }
    return route.continue();
  });
  /* The server's quote for each shot's own request: the first two on one engine, the third on a cheaper one. */
  await page.route("**/api/generate/quote", async (route) => {
    const body = route.request().postDataJSON() as { model?: { id?: string } | string };
    const id = typeof body.model === "string" ? body.model : body.model?.id;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ estimatedCredits: id === KLING ? prices[2] : prices[0], fingerprint: "q".repeat(64) }) });
  });
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || /\/release$/.test(path) || path.startsWith("/api/workbench/atomik"))) paid.push(path);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?project=${project.id}&${query}`);
  await expect(page.getByTestId("phone-app")).toBeVisible();
  return { project, posts, paid, errors };
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function floors(page: Page, where: string) {
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, ".ph-app"), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page, ".ph-app"), `${where}: labels under the floor`).toEqual([]);
  expect(await noOverflow(page), `${where}: sideways overflow`).toBe(true);
  expect(await lastRowClearsPinned(page), `${where}: the last row clears the pinned actions`).toEqual([]);
}

test("the proposal: the three lines at the server's prices, the Total, the most with fixes and the balance after; Build is free", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const { posts, paid, errors } = await open(page, proposal(500, 486), [43, 43, 7]);
  await expect(page.getByTestId("phone-title")).toHaveText("Plan approval");
  await expect(page.getByTestId("mobile-dock")).toHaveCount(0);
  await expect(page.getByTestId("phone-plan-title")).toHaveText("Make 3 shots");
  const rows = page.getByTestId("phone-plan-step");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Opening");
  await expect(rows.nth(0).locator(".gx-price")).toHaveText("43 cr");
  await expect(rows.nth(1).locator(".gx-price")).toHaveText("43 cr");
  await expect(rows.nth(2).locator(".gx-price")).toHaveText("7 cr");
  await expect(rows.nth(0).locator(".gx-price")).toHaveAttribute("title", /^\$[\d.]+$/);
  await expect(page.getByTestId("phone-plan-total")).toContainText("93 cr");
  /* At most 2 × the Total with fixes; building approves no spending, so the button carries no figure. */
  await expect(page.getByTestId("phone-plan-fixes")).toContainText("up to 2 per shot");
  await expect(page.getByTestId("phone-plan-fixes")).toContainText("at most 186 cr");
  await expect(page.getByTestId("phone-plan-balance")).toContainText(/Balance after · [\d,]+ cr now/);
  await expect(page.getByTestId("phone-plan-primary")).toHaveText("Build · free");
  await expect(page.getByTestId("phone-plan-primary")).toBeEnabled();
  /* No SH-style ids anywhere on the screen (DECISIONS 39). */
  expect(await page.getByTestId("phone-plan").innerText()).not.toMatch(/\bSH\d\d\b|Keyframes/);
  await floors(page, "Plan");
  await shot(page, info.project.name, "plan");
  expect(posts).toEqual([]);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Build sends the run's own approval of the build and nothing paid, then Home says so", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const { posts, paid } = await open(page, proposal(500, 486), [43, 43, 7]);
  await expect(page.getByTestId("phone-plan-primary")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("phone-plan-primary").click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ action: "agent.approve", runId: RUN_ID, fingerprint: FP });
  await expect(page.getByTestId("toast")).toContainText("Building the board · free");
  await expect(page.getByTestId("phone-home")).toBeVisible();
  expect(paid).toEqual([]);
});

test("the plan gate: Make 3 shots · 93 cr · at most 186 cr from the server, the price is the button, and one tap sends the plan's approval", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  /* The browser's own quotes would say 1 cr each: the screen shows the server's plan quote. */
  const { posts, paid, errors } = await open(page, gate([43, 43, 7]), [1, 1, 1]);
  await expect(page.getByTestId("mobile-dock")).toHaveCount(0);
  await expect(page.getByTestId("phone-plan-title")).toHaveText("Make 3 shots · 93 cr · at most 186 cr");
  await expect(page.getByTestId("phone-plan-total")).toContainText("93 cr");
  await expect(page.getByTestId("phone-plan-fixes")).toContainText("at most 186 cr");
  await expect(page.getByTestId("phone-plan-primary")).toHaveText("Approve · 93 cr");
  await floors(page, "Plan gate");
  await shot(page, info.project.name, "plan-gate");
  expect(posts).toEqual([]);
  if (PORTRAIT.includes(info.project.name)) {
    await page.getByTestId("phone-plan-primary").click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({ productionId: expect.any(String), action: "agent.approvePlan", runId: RUN_ID, fingerprint: QUOTE_FP });
    await expect(page.getByTestId("toast")).toContainText("Approved · 93 cr, at most 186 cr with fixes");
    await expect(page.getByTestId("phone-home")).toBeVisible();
  }
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Hold goes Home and calls nothing", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const { posts, paid } = await open(page, proposal(500, 486), [43, 43, 7]);
  await expect(page.getByTestId("phone-plan-step")).toHaveCount(3);
  await page.getByTestId("phone-plan-hold").click();
  await expect(page.getByTestId("toast")).toContainText("Held · the plan is kept · nothing spent");
  await expect(page.getByTestId("phone-home")).toBeVisible();
  expect(posts).toEqual([]);
  expect(paid).toEqual([]);
});

test("a short balance at the plan gate: the card says by how much, offers Top up, and Approve waits", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const { posts } = await open(page, gate([120, 120, 120]), [120, 120, 120], "screen=plan&credits=short");
  const card = page.getByTestId("phone-plan-short");
  await expect(card).toContainText(/Short by [\d.,]+ cr/, { timeout: 20_000 });
  await expect(card).toContainText("Top up, then approve. Nothing is spent until you do.");
  await expect(page.getByTestId("phone-plan-primary")).toBeDisabled();
  await expect(page.getByTestId("phone-plan-balance")).toContainText("short by");
  await floors(page, "Plan, short");
  await shot(page, info.project.name, "plan-short");
  await page.getByTestId("phone-plan-topup").click();
  await expect(page).toHaveURL(/view=workspace/);
  await expect(page).toHaveURL(/tab=credits/);
  expect(posts).toEqual([]);
});

test("offline: Approve says it needs a connection", async ({ page, context }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const { posts } = await open(page, proposal(500, 486), [43, 43, 7]);
  await expect(page.getByTestId("phone-plan-step")).toHaveCount(3);
  await context.setOffline(true);
  await expect(page.getByTestId("phone-plan-primary")).toHaveText("Needs a connection");
  await expect(page.getByTestId("phone-plan-primary")).toBeDisabled();
  expect(posts).toEqual([]);
  await context.setOffline(false);
});

test("Change hands the plan to Atomik's sheet with the words started, and calls nothing", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const { posts, paid } = await open(page, proposal(500, 486), [43, 43, 7]);
  await expect(page.getByTestId("phone-plan-step")).toHaveCount(3);
  await page.getByTestId("phone-plan-change").click();
  await expect(page.getByTestId("phone-atomik")).toBeVisible();
  await expect(page.getByTestId("phone-atomik-input")).toHaveValue("Change the plan: ");
  /* The plan is still under the sheet; closing it returns to the plan. */
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("phone-plan-title")).toBeVisible();
  expect(posts).toEqual([]);
  expect(paid).toEqual([]);
});

test("device=phone frames the plan at 390 px on a desktop, with no overflow", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), "desktop widths");
  await open(page, proposal(500, 486), [43, 43, 7], "device=phone&screen=plan");
  await expect(page.getByTestId("phone-plan-step")).toHaveCount(3);
  expect(Math.round((await page.getByTestId("phone-app").boundingBox())!.width)).toBe(390);
  await floors(page, "Framed plan");
  await shot(page, info.project.name, "framed-plan");
});
