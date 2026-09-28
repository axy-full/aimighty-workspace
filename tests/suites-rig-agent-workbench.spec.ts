import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * Atomik builds the board (plan PR 9). On the Suites Rig a person asks Atomik
 * for a board; Atomik proposes the cards and wires (a proposal card: free,
 * with any render shown as the priced next step, never run); the person
 * approves; the cards arrive live in every open Rig window; and Undo takes the
 * build off again, softly. Real local ENGINE_MOCK=1 server throughout: the
 * planner is the scripted mock through the real tools, nothing paid is sent,
 * and with no live room locally each window's 5-second check carries the cards.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const shot = (id: string, title: string, x: number, y: number): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `agent-${Date.now().toString(36)}`, nodes: [shot("theirs", "Ana's opening", 100, 100)] };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { draft, headers, productionId: productionProjectId };
}

/** One Rig window on the project's graph, joined to its team canvas; any paid request fails the test. */
async function openRig(tab: Page, draftId: string, errors: string[], paid: string[]) {
  await forbidPaidWork(tab);
  tab.on("pageerror", (error) => errors.push(error.message));
  tab.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "GET" && /^\/api\/(generate|jobs|workbench\/atomik|atomik|workbench\/development)(\/|$)/.test(url.pathname)) paid.push(`${request.method()} ${url.pathname}`);
  });
  await tab.goto(`/suites?suite=studio&page=rig&project=${draftId}`);
  await expect(tab.getByTestId("rig-team")).toContainText("Team canvas");
  await tab.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(tab.getByTestId("rig-graph-surface")).toBeVisible();
}

const cardIds = (tab: Page) => tab.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".pxw-graph-node[data-node-id]")).map((el) => el.dataset.nodeId!).sort());
const kindsOn = (tab: Page) => tab.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".pxw-graph-node .pxw-graph-kind")).map((el) => el.textContent!.trim()).sort());
const canvasOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, CanvasNode>; removedIds: string[]; serverMade: Record<string, string> } | null };
const agentOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1`, { headers }).then((r) => r.json())) as { agent: { enabled: boolean; run: { id: string; state: string; proposal: { fingerprint: string } | null; built: { cards: number; wires: number }; undo: { removed: number; kept: number } | null; credits: number } | null } };
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

/** Scrolls the stage until a control sits above a phone's fixed tab bar, then answers it. */
async function reach(tab: Page, testId: string) {
  const control = tab.getByTestId(testId);
  await control.scrollIntoViewIfNeeded();
  await tab.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)!;
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    const floor = bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : innerHeight;
    const box = el.getBoundingClientRect();
    if (box.bottom <= floor - 8) return;
    let pane = el.parentElement;
    while (pane && !(["auto", "scroll"].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
    (pane ?? document.scrollingElement!).scrollTop += box.bottom - (floor - 8);
  }, testId);
  return control;
}

async function floors(tab: Page, where: string, phone: boolean) {
  expect(await noSideways(tab), `${where}: no sideways scroll`).toBe(true);
  expect(await smallInCard(tab), `${where}: text under 12px`).toEqual([]);
  expect(await dimLabels(tab, '[data-testid="rig-agent"]'), `${where}: labels under #7C7C84`).toEqual([]);
  if (phone) expect(await smallTargets(tab, '[data-testid="rig-agent"]'), `${where}: targets under 44×44`).toEqual([]);
}

test("ask Atomik for a board: it proposes the cards and wires, free; approved, they arrive live in two open Rig windows; Undo takes them off in both", async ({ page, context }, info) => {
  const phone = PHONES.includes(info.project.name);
  const { draft, headers, productionId } = await setUp(page, "Harbour build");
  const errors: string[] = [], paid: string[] = [];
  const second = await context.newPage();
  await openRig(page, draft.id, errors, paid);
  await openRig(second, draft.id, errors, paid);
  for (const tab of [page, second]) await expect.poll(() => cardIds(tab)).toEqual(["theirs"]);
  await expect.poll(async () => Object.keys((await canvasOf(page.request, headers, productionId)).canvas?.nodes ?? {})).toEqual(["theirs"]);

  /* Ask. The card says building is free before anything is asked. */
  const card = page.getByTestId("rig-agent");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("rig-agent-free")).toHaveText("Free");
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Build the board");
  await floors(page, "ask", phone);
  await (await reach(page, "rig-agent-goal")).fill("The captain on the pier at dawn, two shots.");
  await (await reach(page, "rig-agent-propose")).click();

  /* The proposal: the cards by kind, the wires and the tidy, free; the renders shown as the priced next step. */
  const proposal = card.getByTestId("rig-agent-proposal");
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Proposal");
  await expect(proposal).toContainText("2-shot board");
  await expect(proposal.locator("li[data-kind='cast']")).toContainText("Cast · 1");
  await expect(proposal.locator("li[data-kind='environment']")).toContainText("Environment · 1");
  await expect(proposal.locator("li[data-kind='shot']")).toContainText("Shot · 2");
  await expect(proposal.locator("li[data-kind='shot']")).toContainText("01 — Opening · 02 — The turn");
  await expect(card.getByTestId("rig-agent-count")).toHaveText("4 cards · 4 wires · tidied · free");
  await expect(card.getByTestId("rig-agent-next")).toHaveText("Next: render 2 shots · priced, each one approved first");
  await expect(card.getByTestId("rig-agent-approve")).toHaveText("Build · free");
  /* Nothing is on the board until it is approved. */
  expect(await cardIds(page)).toEqual(["theirs"]);
  await floors(page, "proposal", phone);
  if (info.project.name === "workbench-1440x900") await card.screenshot({ path: info.outputPath("proposal-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-390x844") await card.screenshot({ path: info.outputPath("proposal-390x844.png"), animations: "disabled" });

  /* Approve: the build lands step by step, and both windows show it. */
  await (await reach(page, "rig-agent-approve")).click();
  await expect(card.getByTestId("rig-agent-built")).toHaveText("Built · 4 cards · 4 wires · free", { timeout: 30_000 });
  for (const tab of [page, second]) {
    await expect.poll(async () => (await cardIds(tab)).length, { timeout: 20_000 }).toBe(5);
    await expect.poll(() => kindsOn(tab)).toEqual(["CAST", "ENVIRONMENT"]);
  }
  await expect(second.getByTestId("rig-team-agent")).toContainText("Atomik · built on the board", { timeout: 15_000 });
  /* The priced renders stay a next step: shown, never run. */
  await expect(card.getByTestId("rig-agent-next")).toHaveText("Next: render 2 shots · priced, each one approved first");
  const built = await canvasOf(page.request, headers, productionId);
  const made = Object.entries(built.canvas!.serverMade).filter(([, by]) => by.startsWith("agent:")).map(([id]) => id);
  expect(made).toHaveLength(4);
  expect(built.canvas!.nodes.theirs).toMatchObject({ title: "Ana's opening", x: 100, y: 100 });
  await floors(page, "built", phone);
  if (info.project.name === "workbench-1440x900") await page.screenshot({ path: info.outputPath("built-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-390x844") await second.screenshot({ path: info.outputPath("built-second-window-390x844.png"), animations: "disabled" });

  /* Undo: the build comes off in both windows, softly (the team canvas keeps the cards), and Ana's card stays. */
  await (await reach(page, "rig-agent-undo")).click();
  await expect(card.getByTestId("rig-agent-undone")).toContainText("Undone · 4 cards taken off", { timeout: 20_000 });
  for (const tab of [page, second]) await expect.poll(() => cardIds(tab), { timeout: 20_000 }).toEqual(["theirs"]);
  await expect(second.getByTestId("rig-team-agent")).toContainText("Atomik · took its build off the board", { timeout: 15_000 });
  const after = await canvasOf(page.request, headers, productionId);
  expect(Object.keys(after.canvas!.nodes)).toEqual(["theirs"]);
  expect(after.canvas!.removedIds.sort()).toEqual(made.sort());
  await floors(page, "undone", phone);
  /* A new build can be asked for; nothing paid was ever sent. */
  await expect(card.getByTestId("rig-agent-new")).toBeVisible();
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("the Atomik build API: free, checked, scoped to this workspace and production; approve only as shown; undo once", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: API only");
  const { draft, headers, productionId } = await setUp(page, "Build API");
  const api = page.request;
  expect((await api.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: [shot("theirs", "Ana's opening", 100, 100)], removeNodes: [], upsertAssets: [], order: ["theirs"] } })).ok()).toBe(true);
  expect(await agentOf(api, headers, productionId)).toEqual({ agent: { enabled: true, run: null } });
  const post = (data: Record<string, unknown>, withScope = true) => api.post("/api/workbench/team-canvas", { ...(withScope ? { headers } : {}), data: { productionId, ...data } });
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001" })).status()).toBe(400);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots.", productionId: "not-here" })).status()).toBe(404);
  expect((await post({ action: "agent.plan", projectId: "someone-else", requestId: "req-api-00000001", goal: "Two shots." })).status()).toBe(404);
  expect((await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots." }, false)).status()).toBe(409);
  const asked = await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots." });
  expect(asked.status()).toBe(202);
  const first = await asked.json();
  expect(first).toMatchObject({ agent: { enabled: true, run: { state: "planning", credits: 0 } }, credits: 0 });
  const runId = first.agent.run.id as string;
  /* The same request again is the same run. */
  expect((await (await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000001", goal: "Two shots." })).json()).agent.run.id).toBe(runId);
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 20_000 }).toBe("awaiting_approval");
  const proposed = (await agentOf(api, headers, productionId)).agent.run!;
  expect((await post({ action: "agent.approve", runId, fingerprint: "0".repeat(64) })).status()).toBe(409);
  expect((await post({ action: "agent.approve", runId: "rar_000000000000000000000000", fingerprint: proposed.proposal!.fingerprint })).status()).toBe(404);
  const approved = await post({ action: "agent.approve", runId, fingerprint: proposed.proposal!.fingerprint });
  expect(approved.status()).toBe(200);
  expect(await approved.json()).toMatchObject({ agent: { run: { state: "running", credits: 0 } }, credits: 0 });
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 20_000 }).toBe("done");
  expect((await agentOf(api, headers, productionId)).agent.run).toMatchObject({ built: { cards: 4, wires: 4 }, credits: 0 });
  expect(Object.keys((await canvasOf(api, headers, productionId)).canvas!.nodes)).toHaveLength(5);
  /* A stop on a finished build changes nothing; undo takes the build off once. */
  expect((await (await post({ action: "agent.stop", runId })).json()).agent.run.state).toBe("done");
  const undone = await (await post({ action: "agent.undo", runId })).json();
  expect(undone).toMatchObject({ agent: { run: { undo: { removed: 4, kept: 0 }, canUndo: false } }, credits: 0 });
  expect(Object.keys((await canvasOf(api, headers, productionId)).canvas!.nodes)).toEqual(["theirs"]);
  expect((await (await post({ action: "agent.undo", runId })).json()).agent.run.undo).toEqual(undone.agent.run.undo);
  /* A proposal set aside builds nothing. */
  const again = await (await post({ action: "agent.plan", projectId: draft.id, requestId: "req-api-00000002", goal: "One shot." })).json();
  await expect.poll(async () => (await agentOf(api, headers, productionId)).agent.run?.state, { timeout: 20_000 }).toBe("awaiting_approval");
  const declined = await (await post({ action: "agent.decline", runId: again.agent.run.id })).json();
  expect(declined.agent.run).toMatchObject({ state: "stopped", built: { cards: 0, wires: 0 }, canUndo: false });
  expect(Object.keys((await canvasOf(api, headers, productionId)).canvas!.nodes)).toEqual(["theirs"]);
});
