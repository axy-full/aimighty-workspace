import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * Atomik renders drafts inside a limit a person approved (plan PR 10). On the
 * Suites Rig a person asks Atomik for a board with a limit for the run ("up to
 * about N cr") and a mode; Atomik plans inside that limit (the planning turn is
 * metered into it), builds the board once approved, and then renders each shot
 * the plan names as a draft: in Ask mode after one tap each, in Auto on its own
 * while a render is at or under the per-job line. A render that would pass the
 * limit waits for a person ("needs you"); Stop lets go of everything not sent.
 *
 * Real local ENGINE_MOCK=1 server throughout: the planner is the scripted mock,
 * renders are the mock engine, the browser never sends a paid request itself
 * (every render is admitted by Atomik's worker, server-side), and the balance
 * read back from the server moves by exactly what the card says settled.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const DESKS = ["workbench-1440x900", "workbench-1920x1080"];
const shot = (id: string, title: string, x: number, y: number): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

type Paid = { seq: number; tool: string; title: string; state: string; quote: number | null; charged: number | null; outcome: string | null; pause: string | null; canRender: boolean; fingerprint: string | null };
type Run = {
  id: string; state: string; reason: string | null; credits: number;
  money: { limit: number; mode: string; jobCeiling: number; spent: number; inFlight: number; left: number; planning: { state: string; credits: number | null } | null } | null;
  paid: Paid[]; proposal: { fingerprint: string } | null;
};
type Agent = { agent: { enabled: boolean; run: Run | null; ask: { limit: number; jobCeiling: number; planning: number | null } | null } };

async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `runs-${Date.now().toString(36)}`, nodes: [shot("theirs", "Ana's opening", 100, 100)] };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { draft, headers, productionId: productionProjectId };
}

/** One Rig window on the project, joined to its team canvas; any paid request from the browser fails the test. */
async function openRig(tab: Page, draftId: string, errors: string[], paid: string[]) {
  await forbidPaidWork(tab);
  tab.on("pageerror", (error) => errors.push(error.message));
  tab.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "GET" && /^\/api\/(generate|jobs|workbench\/atomik|atomik|workbench\/development)(\/|$)/.test(url.pathname)) paid.push(`${request.method()} ${url.pathname}`);
  });
  await tab.goto(`/suites?suite=studio&page=rig&project=${draftId}`);
  await expect(tab.getByTestId("rig-team")).toContainText("Team canvas");
}

const agentOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string, projectId?: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1${projectId ? `&projectId=${projectId}` : ""}`, { headers }).then((r) => r.json())) as Agent;
const balanceOf = async (api: APIRequestContext) => Number((await (await api.get("/api/me")).json()).credits.balance);
const cr = (n: number) => `${Math.round(n * 10) % 10 ? (Math.round(n * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1 }) : Math.round(n).toLocaleString("en-US")} cr`;
const noSideways = (tab: Page) => tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5);
/** Every text in the run card at 12px or more. */
const smallInCard = (tab: Page) => tab.evaluate(() => {
  const out: string[] = [];
  const root = document.querySelector('[data-testid="rig-agent"]');
  if (!root) return ["no card"];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!(node.textContent ?? "").trim() || !el || !el.getClientRects().length) continue;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (size < 12) out.push(`${size}px: ${(node.textContent ?? "").trim().slice(0, 30)}`);
  }
  return out;
});
/** No price in the card is cut short: nothing that shows credits is ellipsized or clipped. */
const clippedPrices = (tab: Page) => tab.evaluate(() => {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rig-agent"] *'))) {
    if (!/\d\s?cr\b/.test(el.textContent ?? "") || el.children.length) continue;
    const style = getComputedStyle(el);
    if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 0.5) out.push(`ellipsized: ${el.textContent}`);
    if (el.scrollWidth > el.clientWidth + 0.5 && ["hidden", "clip"].includes(style.overflowX)) out.push(`clipped: ${el.textContent}`);
  }
  return out;
});

/** Scrolls the stage until a control sits above a phone's fixed tab bar, then answers it. */
async function reach(tab: Page, testId: string, within?: string) {
  const control = within ? tab.getByTestId(within).getByTestId(testId) : tab.getByTestId(testId);
  await control.scrollIntoViewIfNeeded();
  await tab.evaluate(({ id, within }) => {
    const scope = within ? document.querySelector(`[data-testid="${within}"]`) : document;
    const el = scope?.querySelector(`[data-testid="${id}"]`);
    if (!el) return;
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    const floor = bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : innerHeight;
    const box = el.getBoundingClientRect();
    if (box.bottom <= floor - 8) return;
    let pane = el.parentElement;
    while (pane && !(["auto", "scroll"].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
    (pane ?? document.scrollingElement!).scrollTop += box.bottom - (floor - 8);
  }, { id: testId, within });
  return control;
}

async function floors(tab: Page, where: string, phone: boolean) {
  expect(await noSideways(tab), `${where}: no sideways scroll`).toBe(true);
  expect(await smallInCard(tab), `${where}: text under 12px`).toEqual([]);
  expect(await dimLabels(tab, '[data-testid="rig-agent"]'), `${where}: labels under #7C7C84`).toEqual([]);
  expect(await clippedPrices(tab), `${where}: prices cut short`).toEqual([]);
  if (phone) expect(await smallTargets(tab, '[data-testid="rig-agent"]'), `${where}: targets under 44×44`).toEqual([]);
}

/** Ask for a board in the card with this limit and mode; approve the proposal. Answers the run's id. */
async function askAndBuild(page: Page, input: { goal: string; limit?: number; mode?: "ask" | "auto"; phone: boolean; name: string }) {
  const card = page.getByTestId("rig-agent");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("rig-agent-terms")).toContainText("Planning is priced and counts toward this limit (up to about ");
  await (await reach(page, "rig-agent-goal")).fill(input.goal);
  const field = await reach(page, "rig-agent-limit");
  if (input.limit != null) await field.fill(String(input.limit));
  if (input.mode === "auto") await (await reach(page, "rig-agent-mode-auto")).click();
  await floors(page, `${input.name}: ask`, input.phone);
  await (await reach(page, "rig-agent-propose")).click();
  await expect(card.getByTestId("rig-agent-proposal")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("rig-agent-approve")).toHaveText("Build · free");
  await floors(page, `${input.name}: proposal`, input.phone);
  await (await reach(page, "rig-agent-approve")).click();
}

test("approve a run limit; Ask: each render waits for one tap, the takes land, and the balance moves by exactly what settled", async ({ page }, info) => {
  const phone = PHONES.includes(info.project.name);
  const { draft, headers, productionId } = await setUp(page, "Harbour renders");
  const errors: string[] = [], paid: string[] = [];
  await openRig(page, draft.id, errors, paid);
  const terms = (await agentOf(page.request, headers, productionId, draft.id)).agent.ask!;
  expect(terms.planning).toBeGreaterThan(0);
  /* The card suggests the workspace's own approval line as the run's limit. */
  await expect(page.getByTestId("rig-agent-limit")).toHaveValue(String(terms.limit));
  await expect(page.getByTestId("rig-agent-propose")).toHaveText(`Propose a board · up to about ${cr(terms.planning!)}`);
  const start = await balanceOf(page.request);
  await askAndBuild(page, { goal: "The captain on the pier at dawn, two shots.", phone, name: "ask" });
  const card = page.getByTestId("rig-agent");

  /* The build lands; the first render is priced and waits for a tap. Nothing paid has happened but planning. */
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Needs you", { timeout: 40_000 });
  const firstRow = card.getByTestId("rig-agent-renders").locator("li[data-tool='render']").first();
  await expect(firstRow).toHaveAttribute("data-state", "waiting");
  let run = (await agentOf(page.request, headers, productionId)).agent.run!;
  const first = run.paid.find((p) => p.tool === "render" && p.state === "waiting")!;
  await expect(card.getByTestId("rig-agent-needs")).toHaveText(`${first.title} is ready to render · about ${cr(first.quote!)}.`);
  await expect(card.getByTestId("rig-agent-render")).toHaveText(`Render · about ${cr(first.quote!)}`);
  expect(run.money).toMatchObject({ mode: "ask", inFlight: 0 });
  const planning = run.money!.planning!.credits!;
  expect(run.money!.planning!.state).toBe("settled");
  expect(await balanceOf(page.request)).toBe(start - planning);
  await expect(card.getByTestId("rig-agent-spend")).toHaveText(`${cr(planning)} of ${cr(run.money!.limit)}`);
  await floors(page, "ask: waiting for a tap", phone);
  if (info.project.name === "workbench-1440x900") await card.screenshot({ path: info.outputPath("ask-waiting-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-390x844") await card.screenshot({ path: info.outputPath("ask-waiting-390x844.png"), animations: "disabled" });

  /* Tap one: it renders (a mock draft) and settles; the second waits for its own tap. */
  await (await reach(page, "rig-agent-render")).click();
  await expect(firstRow).toHaveAttribute("data-state", "done", { timeout: 60_000 });
  await expect(card.getByTestId("rig-agent-renders").locator("li[data-tool='render']").nth(1)).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
  run = (await agentOf(page.request, headers, productionId)).agent.run!;
  const took1 = run.paid.find((p) => p.seq === first.seq)!;
  expect(took1.charged).toBeGreaterThan(0);
  await expect(firstRow.getByTestId("rig-agent-render-price")).toHaveText(`${cr(took1.charged!)} settled`);
  await floors(page, "ask: one rendered", phone);
  await (await reach(page, "rig-agent-render")).click();
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Build the board", { timeout: 60_000 });
  run = (await agentOf(page.request, headers, productionId)).agent.run!;
  expect(run.state).toBe("done");
  const renders = run.paid.filter((p) => p.tool === "render");
  expect(renders.map((p) => p.state)).toEqual(["done", "done"]);
  /* The checks of the takes are shown, never run or charged yet. */
  expect(run.paid.filter((p) => p.tool === "verify").every((p) => p.state === "next" && p.charged == null)).toBe(true);
  const settled = renders.reduce((sum, p) => sum + p.charged!, 0);
  expect(run.money).toMatchObject({ spent: Math.round((planning + settled) * 10) / 10, inFlight: 0 });
  /* The balance moved by exactly what the card says settled, and never past the limit. */
  expect(Math.round((start - (await balanceOf(page.request))) * 10) / 10).toBe(run.money!.spent);
  expect(run.money!.spent).toBeLessThanOrEqual(run.money!.limit);
  await expect(card.getByTestId("rig-agent-total")).toContainText(`2 drafts rendered · ${cr(run.money!.spent)} spent of ${cr(run.money!.limit)}`);
  await floors(page, "ask: done", phone);
  if (info.project.name === "workbench-1440x900") await card.screenshot({ path: info.outputPath("ask-done-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-360x640") await card.screenshot({ path: info.outputPath("ask-done-360x640.png"), animations: "disabled" });
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Auto: renders under the per-job line run on their own, with no tap, up to the run's limit; the one that would pass it pauses the run with 'needs you' and reserves nothing; raising the limit carries on", async ({ page }, info) => {
  const phone = PHONES.includes(info.project.name);
  const { draft, headers, productionId } = await setUp(page, "Harbour auto");
  const errors: string[] = [], paid: string[] = [];
  await openRig(page, draft.id, errors, paid);
  /* What planning may cost here, and what one draft of a shot costs (the Rig's own quote): the limit covers planning and a draft, not all six. */
  const terms = (await agentOf(page.request, headers, productionId, draft.id)).agent.ask!;
  const quote = await (await page.request.get("/api/workbench/engines?model=dreamina-seedance-2-5-260628&resolution=480p&ratio=16:9&duration=5", { headers })).json() as { credits: number };
  expect(quote.credits).toBeGreaterThan(0);
  const limit = Math.ceil((terms.planning! + quote.credits) * 10) / 10;
  const clicks: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /"action":"agent\.render"/.test(request.postData() ?? "")) clicks.push("render"); });
  await askAndBuild(page, { goal: "The captain on the pier at dawn, six shots.", limit, mode: "auto", phone, name: "auto" });
  const card = page.getByTestId("rig-agent");
  /* With no tap: a render runs on its own, then the one that would pass the limit asks. */
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Needs you", { timeout: 90_000 });
  let run = (await agentOf(page.request, headers, productionId)).agent.run!;
  expect(run.money).toMatchObject({ mode: "auto", limit });
  await expect(card.getByTestId("rig-agent-mode-line")).toHaveText(` · Auto up to about ${cr(run.money!.jobCeiling)} a render`);
  const renders = run.paid.filter((p) => p.tool === "render");
  const ranAlone = renders.filter((p) => ["rendering", "done", "failed"].includes(p.state)).length;
  expect(ranAlone).toBeGreaterThanOrEqual(1);
  expect(clicks).toEqual([]);
  const paused = run.paid.find((p) => p.state === "paused")!;
  expect(paused).toMatchObject({ pause: "limit", canRender: true });
  expect(paused.quote!).toBeLessThanOrEqual(run.money!.jobCeiling);
  expect(run.reason).toMatch(/^The next render is about [\d.,]+ cr; this run's limit of [\d.,]+ cr leaves about [\d.,]+ cr\. Raise the limit, skip this render, or stop\.$/);
  await expect(card.getByTestId("rig-agent-needs")).toHaveText(run.reason!);
  /* Nothing was reserved for it: settled and in flight together never pass the limit. */
  expect(run.money!.spent + run.money!.inFlight).toBeLessThanOrEqual(limit);
  await floors(page, "auto: at the limit", phone);
  if (info.project.name === "workbench-390x844") await card.screenshot({ path: info.outputPath("auto-limit-390x844.png"), animations: "disabled" });
  if (info.project.name === "workbench-1920x1080") await card.screenshot({ path: info.outputPath("auto-limit-1920x1080.png"), animations: "disabled" });
  /* Raise the limit (the card suggests enough for the next render): it goes, still with no tap on a render. */
  await expect(card.getByTestId("rig-agent-raise")).toBeVisible();
  const suggested = Number(await card.getByTestId("rig-agent-raise-limit").inputValue());
  expect(suggested).toBeGreaterThan(limit);
  await (await reach(page, "rig-agent-raise-button")).click();
  await expect.poll(async () => (await agentOf(page.request, headers, productionId)).agent.run!.paid.filter((p) => p.tool === "render" && ["rendering", "done", "failed"].includes(p.state)).length, { timeout: 60_000 })
    .toBeGreaterThan(ranAlone);
  run = (await agentOf(page.request, headers, productionId)).agent.run!;
  expect(run.money!.limit).toBe(suggested);
  expect(run.money!.spent + run.money!.inFlight).toBeLessThanOrEqual(run.money!.limit);
  expect(clicks).toEqual([]);
  /* Stop: the rest is let go. */
  await (await reach(page, "rig-agent-stop")).click();
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Build the board", { timeout: 30_000 });
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Stop lets go of every render not sent, and what was on its way settles: nothing stays reserved for the run", async ({ page }, info) => {
  const phone = PHONES.includes(info.project.name);
  const { draft, headers, productionId } = await setUp(page, "Harbour stop");
  const errors: string[] = [], paid: string[] = [];
  await openRig(page, draft.id, errors, paid);
  const start = await balanceOf(page.request);
  await askAndBuild(page, { goal: "The captain on the pier at dawn, three shots.", phone, name: "stop" });
  const card = page.getByTestId("rig-agent");
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Needs you", { timeout: 40_000 });
  /* One render sent, then Stop while the next ones wait. */
  await (await reach(page, "rig-agent-render")).click();
  await expect.poll(async () => (await agentOf(page.request, headers, productionId)).agent.run!.paid.find((p) => p.tool === "render")!.state, { timeout: 30_000 })
    .toMatch(/^(rendering|done)$/);
  await (await reach(page, "rig-agent-stop")).click();
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Build the board", { timeout: 30_000 });
  /* What was on its way settles; nothing else was sent, and nothing stays reserved. */
  await expect.poll(async () => (await agentOf(page.request, headers, productionId)).agent.run!.money!.inFlight, { timeout: 60_000 }).toBe(0);
  const run = (await agentOf(page.request, headers, productionId)).agent.run!;
  expect(run.state).toBe("stopped");
  const renders = run.paid.filter((p) => p.tool === "render");
  expect(renders[0].state).toMatch(/^(done|failed)$/);
  expect(renders.slice(1).map((p) => [p.state, p.charged])).toEqual([["skipped", null], ["skipped", null]]);
  expect(Math.round((start - (await balanceOf(page.request))) * 10) / 10).toBe(run.money!.spent);
  await expect(card.getByTestId("rig-agent-total")).toContainText(`${cr(run.money!.spent)} spent of ${cr(run.money!.limit)}`);
  /* Nothing more goes after a stop. */
  await page.waitForTimeout(4000);
  expect((await agentOf(page.request, headers, productionId)).agent.run!.paid.filter((p) => p.tool === "render").map((p) => p.state)).toEqual(renders.map((p) => p.state));
  await floors(page, "stopped", phone);
  if (DESKS.includes(info.project.name)) await card.screenshot({ path: info.outputPath(`stopped-${info.project.name}.png`), animations: "disabled" });
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("the run API: a limit is required and bounded; only the person who asked taps, at the price shown; a tap twice approves once", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: API only");
  const { draft, headers, productionId } = await setUp(page, "Runs API");
  const api = page.request;
  expect((await api.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: [shot("theirs", "Ana's opening", 100, 100)], removeNodes: [], upsertAssets: [], order: ["theirs"] } })).ok()).toBe(true);
  const post = (data: Record<string, unknown>) => api.post("/api/workbench/team-canvas", { headers, data: { productionId, ...data } });
  /* No limit, a nonsense limit, or one past the most a run may have: refused before anything runs. */
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots." })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: -5 })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 12.34 })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 2_000_000 })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 500, mode: "sometimes" })).status()).toBe(400);
  const asked = await post({ action: "agent.plan", projectId: draft.id, requestId: "req-runs-00000001", goal: "Two shots.", limit: 500 });
  expect(asked.status()).toBe(202);
  const runId = (await asked.json()).agent.run.id as string;
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 20_000 }).toBe("awaiting_approval");
  const fingerprint = (await agentOf(api, headers, productionId)).agent.run!.proposal!.fingerprint;
  expect((await post({ action: "agent.approve", runId, fingerprint })).status()).toBe(200);
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 30_000 }).toBe("needs_you");
  const run = (await agentOf(api, headers, productionId)).agent.run!;
  const waiting = run.paid.find((p) => p.state === "waiting")!;
  /* The card never carries the priced request itself, only its price and fingerprint. */
  expect(JSON.stringify(run)).not.toMatch(/compiled|estUsd|engine_cost|vendor/i);
  expect((await post({ action: "agent.render", runId, seq: waiting.seq, fingerprint: "0".repeat(64) })).status()).toBe(409);
  expect((await post({ action: "agent.render", runId, seq: 999, fingerprint: waiting.fingerprint })).status()).toBe(404);
  expect((await post({ action: "agent.limit", runId, limit: 499 })).status()).toBe(409);
  const tap = await post({ action: "agent.render", runId, seq: waiting.seq, fingerprint: waiting.fingerprint });
  expect(tap.status()).toBe(200);
  /* The same tap again (a lost reply): the same answer, one render. */
  expect((await post({ action: "agent.render", runId, seq: waiting.seq, fingerprint: waiting.fingerprint })).status()).toBe(200);
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run!.paid.find((p) => p.seq === waiting.seq)!.state, { timeout: 60_000 }).toBe("done");
  const jobs = (await (await api.get("/api/jobs?sync=0", { headers })).json()) as { generations?: unknown[]; jobs?: unknown[] };
  const list = (jobs.generations ?? jobs.jobs ?? []) as { id: string }[];
  expect(list.length).toBe(1);
  expect((await post({ action: "agent.stop", runId })).status()).toBe(200);
});
