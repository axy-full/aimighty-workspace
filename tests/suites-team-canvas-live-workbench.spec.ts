import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * Server-made changes appear live for everyone (plan §5, PR 5). The server
 * changes a production's team canvas through applyCanvasOps; its first user
 * is Tidy, which lays the board out for the whole team and is free. With no
 * live room (a local server has no Liveblocks key), every open Rig checks
 * every few seconds whether the server changed the canvas and folds it in,
 * naming Atomik as the one who did it. Real server throughout: two tabs of
 * one person, each its own Rig window, in the Suites (the site on every device).
 */
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const shot = (id: string, title: string, x: number, y: number, linked: string[] = []): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked, role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});
/* Drafted scattered: b takes a as its input; c stands alone. */
const board = () => [shot("a", "Harbour wide", 900, 700), shot("b", "The encounter", 100, 1200, ["a"]), shot("c", "Departure", 1500, 100)];
/* Tidied (columns by input depth, rows in order): a (60,70), b (460,70), c (60,448); on the graph, shifted to the top-left card. */
const TIDIED = { a: { left: 20, top: 20 }, b: { left: 420, top: 20 }, c: { left: 20, top: 398 } };
const DRAFTED = { a: { left: 820, top: 620 }, b: { left: 20, top: 1120 }, c: { left: 1420, top: 20 } };

async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `live-${Date.now().toString(36)}`, nodes: board() };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { draft, headers, productionId: productionProjectId };
}

/**
 * The Rig window's canvas, shown. A development server still compiling routes on their first use can reload an open
 * tab, and the Rig then opens on its list, which says "Team canvas" too: every step is retried together, so the canvas
 * is shown again rather than waited on.
 */
async function showCanvas(tab: Page) {
  const board = tab.getByTestId("rig-graph-surface");
  await expect(async () => {
    if (!(await board.isVisible())) await tab.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click({ timeout: 5_000 });
    await expect(board).toBeVisible({ timeout: 5_000 });
    await expect(tab.getByTestId("rig-team")).toContainText("Team canvas", { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

/** One Rig window on the project's graph, joined to its team canvas. */
async function openRig(tab: Page, draftId: string, errors: string[]) {
  await forbidPaidWork(tab);
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`/suites?suite=studio&page=rig&project=${draftId}`);
  await showCanvas(tab);
}

const places = (tab: Page) => tab.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>(".pxw-graph-node[data-node-id]"))
  .map((el) => [el.dataset.nodeId!, { left: Number.parseFloat(el.style.left), top: Number.parseFloat(el.style.top) }])));
/** The cards' places, read on the canvas: shown again first when a reload left the Rig on its list. */
const shownPlaces = async (tab: Page) => { await showCanvas(tab); return places(tab); };
const canvasOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, CanvasNode> } | null; server: { what: string } | null };

const noSideways = (tab: Page) => tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5);

/** Scrolls the board's pane until a control of its zoom cluster sits above a phone's fixed tab bar (the canvas shown again first, as showCanvas does). */
async function reach(tab: Page, testId: string) {
  const control = tab.getByTestId(testId);
  await expect(async () => {
    if (!(await tab.getByTestId("rig-graph-surface").isVisible())) await tab.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click({ timeout: 5_000 });
    await control.scrollIntoViewIfNeeded({ timeout: 5_000 });
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
  }).toPass({ timeout: 60_000 });
  return control;
}

test("a Tidy the server makes appears live in two open Rig windows, with Atomik named as the one who did it", async ({ page, context }, info) => {
  const { draft, headers, productionId } = await setUp(page, "Harbour tidy");
  const errors: string[] = [];
  const second = await context.newPage();
  await openRig(page, draft.id, errors);
  await openRig(second, draft.id, errors);
  /* Both windows show the board as drafted, and the team canvas holds it. */
  for (const tab of [page, second]) await expect.poll(() => shownPlaces(tab)).toEqual(DRAFTED);
  await expect.poll(async () => Object.keys((await canvasOf(page.request, headers, productionId)).canvas?.nodes ?? {}).sort()).toEqual(["a", "b", "c"]);

  /* Neither window asks: the server tidies (as a teammate's Tidy or Atomik would). Free, and no live room locally. */
  const tidied = await page.request.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId: `e2e-${Date.now().toString(36)}` } });
  expect(tidied.ok(), await tidied.text()).toBe(true);
  expect(await tidied.json()).toMatchObject({ moved: 3, live: "off", credits: 0 });

  /* Both windows fold it in within a check or two, and say who did it. */
  for (const tab of [page, second]) {
    await expect.poll(() => shownPlaces(tab), { timeout: 15_000 }).toEqual(TIDIED);
    await expect(tab.getByTestId("rig-team-agent")).toContainText("Atomik · tidied the board");
    expect(await noSideways(tab), "no sideways scroll").toBe(true);
  }
  /* Atomik's name is never dimmer than the brief's label floor (#7C7C84). */
  const ink = await page.getByTestId("rig-team-agent").evaluate((el) => {
    const [r, g, b] = (getComputedStyle(el).color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
  expect(ink).toBeGreaterThanOrEqual(0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5);
  /* What the windows save next carries the tidied places, never the drafted ones back over them. */
  await page.waitForTimeout(1500);
  const nodes = (await canvasOf(page.request, headers, productionId)).canvas!.nodes;
  expect(Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, [n.x, n.y]]))).toEqual({ a: [60, 70], b: [460, 70], c: [60, 448] });
  if (info.project.name === "workbench-1440x900") await second.screenshot({ path: info.outputPath("tidy-second-window-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-390x844") await second.screenshot({ path: info.outputPath("tidy-second-window-390x844.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("pressing Tidy in one window lays the board out in the other too; the button says it is free and keeps the phone floors", async ({ page, context }, info) => {
  const { draft, headers, productionId } = await setUp(page, "Desert tidy");
  const errors: string[] = [];
  const second = await context.newPage();
  await openRig(page, draft.id, errors);
  await openRig(second, draft.id, errors);
  for (const tab of [page, second]) await expect.poll(() => shownPlaces(tab)).toEqual(DRAFTED);
  await expect.poll(async () => Object.keys((await canvasOf(page.request, headers, productionId)).canvas?.nodes ?? {}).length).toBe(3);

  const tidy = await reach(page, "rig-tidy");
  await expect(tidy).toHaveAccessibleName("Tidy the board for everyone, free");
  if (PHONES.includes(info.project.name)) {
    const box = (await tidy.boundingBox())!;
    expect(Math.min(box.width, box.height), "Tidy is a thumb-sized target").toBeGreaterThanOrEqual(44);
    expect(await smallTargets(page, ".pxw-graph-zoom"), "zoom cluster targets under 44×44").toEqual([]);
  }
  await tidy.click();
  await expect(page.getByTestId("rig-graph")).toContainText("Tidied for everyone · 3 cards moved · free");
  await expect.poll(() => shownPlaces(page)).toEqual(TIDIED);
  await expect.poll(() => shownPlaces(second), { timeout: 15_000 }).toEqual(TIDIED);
  await expect(second.getByTestId("rig-team-agent")).toContainText("Atomik · tidied the board");
  /* A second press has nothing left to move. */
  await (await reach(page, "rig-tidy")).click();
  await expect(page.getByTestId("rig-graph")).toContainText("Already tidy · nothing moved");
  for (const tab of [page, second]) expect(await noSideways(tab), "no sideways scroll").toBe(true);
  expect(errors).toEqual([]);
});

test("an edit made in one window while the server tidies is kept: the fold lays the window's own unsent edit over the tidied board", async ({ page, context }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "desktop widths: the shot Inspector's steppers");
  const { draft, headers, productionId } = await setUp(page, "Coast tidy");
  const errors: string[] = [];
  const second = await context.newPage();
  await openRig(page, draft.id, errors);
  await openRig(second, draft.id, errors);
  await expect.poll(async () => Object.keys((await canvasOf(page.request, headers, productionId)).canvas?.nodes ?? {}).length).toBe(3);
  /* The second window makes b a second longer, and the server tidies at once, before that edit is sent. */
  await second.goto(`/suites?suite=studio&page=rig&project=${draft.id}&sel=shot:b`);
  await expect(second.getByTestId("shot-duration")).toHaveText("5s");
  await second.getByRole("button", { name: "Longer" }).click();
  const tidied = await page.request.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId: `e2e-${Date.now().toString(36)}` } });
  expect(tidied.ok()).toBe(true);
  await expect(second.getByTestId("shot-duration")).toHaveText("6s");
  /* Both reach the team canvas: the tidied places and the longer shot. */
  await expect.poll(async () => {
    const b = (await canvasOf(page.request, headers, productionId)).canvas!.nodes.b;
    return [b.x, b.y, b.durationS];
  }, { timeout: 15_000 }).toEqual([460, 70, 6]);
  /* The first window folds both in. The second folds the tidy in too, and still shows its own edit. */
  await expect.poll(() => shownPlaces(page), { timeout: 15_000 }).toEqual(TIDIED);
  await expect(second.getByTestId("rig-team-agent")).toContainText("Atomik · tidied the board", { timeout: 15_000 });
  await expect(second.getByTestId("shot-duration")).toHaveText("6s");
  await showCanvas(second);
  await expect.poll(() => shownPlaces(second)).toEqual(TIDIED);
  expect(errors).toEqual([]);
});

test("the canvas action API: Tidy is free, checked, scoped to this workspace, and a repeated press changes nothing twice", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop: API only");
  const { headers, productionId } = await setUp(page, "Tidy API");
  const api = page.request;
  /* The Rig opens the canvas first; a production nobody opened has nothing to tidy. */
  expect((await api.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: board(), removeNodes: [], upsertAssets: [], order: ["a", "b", "c"] } })).ok()).toBe(true);
  const head = async () => api.get(`/api/workbench/team-canvas?productionId=${productionId}&head=1`, { headers }).then((r) => r.json());
  expect(await head()).toEqual({ head: true, revision: 1, server: null });
  expect((await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId } })).status()).toBe(400);
  expect((await api.post("/api/workbench/team-canvas", { headers, data: { action: "explode", productionId, opId: "abcdefgh" } })).status()).toBe(400);
  expect((await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId: "not-here", opId: "abcdefgh" } })).status()).toBe(404);
  expect((await api.post("/api/workbench/team-canvas", { data: { action: "tidy", productionId, opId: "abcdefgh" } })).status()).toBe(409);
  const opId = `api-${Date.now().toString(36)}`;
  const first = await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId } }).then((r) => r.json());
  expect(first).toEqual({ revision: 2, moved: 3, live: "off", credits: 0 });
  /* The same press arriving twice: the same answer, and the canvas does not move again. */
  expect(await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId } }).then((r) => r.json())).toEqual(first);
  const light = await head();
  expect(light).toMatchObject({ head: true, revision: 2, server: { what: "tidy", agent: false } });
  const full = await canvasOf(api, headers, productionId);
  expect(full.server).toEqual(light.server);
  expect(Object.fromEntries(Object.entries(full.canvas!.nodes).map(([id, n]) => [id, [n.x, n.y]]))).toEqual({ a: [60, 70], b: [460, 70], c: [60, 448] });
  /* A new press on a tidy board: nothing to move, and no news for open windows. */
  expect(await api.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId: `${opId}-again` } }).then((r) => r.json())).toEqual({ revision: 2, moved: 0, live: "off", credits: 0 });
  expect((await head()).server).toEqual(light.server);
});
