import { test, expect, type APIRequestContext, type CDPSession, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode, type NodeType, type Project } from "../lib/workbench/studio";
import { applyTeamPatch, emptyTeamCanvas, orderedIds, type TeamCanvas, type TeamPatch } from "../lib/workbench/team-canvas-model";
import { kindSectionId } from "../lib/workspace/rig-board";
import { CARD_HEIGHT } from "../lib/workspace/rig-graph";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * A tidier Rig board (the agentic canvas, step 2: plan PR 3). A big board
 * reads at a glance: every card shows its preview, what it is (a reference's
 * kind, a shot's type and number), its state and its version; section titles
 * group the cards; notes are written right on the board; a card let go snaps
 * to the 20 px grid (Alt places it exactly) and, let go under a section title,
 * joins that section; and Tidy lays the whole board out by sections on the
 * server, for everyone at once, making the kinds' titles it lacks. All free.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
const ENGINE = "dreamina-seedance-2-5-260628";

const still = (id: string, name: string, category: string, file: "hero" | "character" | "environment"): Asset => ({
  id, name, kind: "image", category, url: `/campaign/${file}.webp`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [],
});
const card = (id: string, title: string, type: NodeType, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, title, type, x, y, width: 220, linked: [], ...extra,
});
const shot = (id: string, title: string, x: number, y: number, linked: string[] = []): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked, role: "Director", status: "draft", mode: "Video", engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p",
});
const section = (id: string, name: string, x: number, y: number): CanvasNode => ({ id, title: name, type: "note", mode: "section", x, y, width: 260, linked: [] });

/** Test fixtures only: a character, a place, a reference, one with nothing attached yet, a note, the shot they feed and a colour card after it. */
function fixture(name: string, id: string): Project {
  return {
    ...newProject(name), id,
    assets: [still("face", "Mira study", "Character", "character"), still("plate", "Dunes plate", "Environment", "environment"), still("frame", "Harbour still", "Reference", "hero")],
    nodes: [
      card("mira", "Mira", "character", 0, 0, { assetId: "face" }),
      card("dunes", "The mirrored dunes", "element", 0, 320, { assetId: "plate" }),
      card("board", "Harbour board", "media", 300, 0, { assetId: "frame" }),
      card("empty", "Pickup plate", "media", 300, 320),
      card("say", "Director's note", "note", 600, 320, { width: 254, role: "Director", text: "Hold the frame.\nLet the fabric move." }),
      shot("open", "The opening", 600, 0, ["mira", "dunes", "board"]),
      card("tone", "Warm grade", "grade", 900, 0, { width: 254, linked: ["open"] }),
    ],
  };
}

/** The team canvas route, in memory, with the server's own merge. */
async function mockTeamCanvas(page: Page, canvas: TeamCanvas) {
  const store = { canvas, patches: [] as (Omit<TeamPatch, "at"> & { productionId: string })[] };
  await page.route("**/api/workbench/team-canvas**", async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { canvas: { nodes: store.canvas.nodes, assets: store.canvas.assets, order: orderedIds(store.canvas), removedIds: Object.keys(store.canvas.removed) }, revision: store.patches.length + 1, room: null } });
    const body = request.postDataJSON();
    store.patches.push(body);
    store.canvas = applyTeamPatch(store.canvas, { ...body, at: Date.now() });
    return route.fulfill({ json: { revision: store.patches.length + 1 } });
  });
  return store;
}

/** A mocked production on its team canvas, the Rig's canvas on screen and fitted (or its shot list, `list`). */
async function openMocked(page: Page, nodes?: CanvasNode[], options: { list?: boolean } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const base = fixture("Mirror study", "ws-board");
  const draft = { ...base, nodes: nodes ?? base.nodes, productionProjectId: "prod-board", shotMappings: {} } as Project;
  const store = { current: draft };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workbench/engines**", (route) => route.fulfill({ json: { credits: 18, models: [] } }));
  const team = await mockTeamCanvas(page, applyTeamPatch(emptyTeamCanvas(), { upsertNodes: draft.nodes, removeNodes: [], upsertAssets: draft.assets, order: draft.nodes.map((n) => n.id), at: 1 }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Mirror study");
  if (!options.list) await showCanvas(page);
  return { errors, store, team };
}

/** The Rig's canvas, scrolled into its pane and fitted, so every card is on screen at any size. */
async function showCanvas(page: Page) {
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  const board = page.getByTestId("rig-graph-surface");
  await expect(board).toBeVisible();
  await expect(page.getByTestId("rig-team")).toContainText("Team canvas");
  await closeOverlay(page);
  await board.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await boardAtRest(page);
  await page.getByTestId("rig-zoom-fit").click();
  await fitted(page);
}

/**
 * The board has stopped moving: its box the same across two animation frames and on two polls running (the page head's
 * rows above it settle as the live price arrives). Fit is pressed only then. Pressed while the board is still sliding,
 * Playwright retries the click with the button scrolled to `start`, which scrolls the board's own overflow-hidden
 * surface: every card is carried off the board's box, and the fit, right as it is, can no longer show them.
 */
async function boardAtRest(page: Page) {
  const board = page.getByTestId("rig-graph-surface");
  let last = "";
  await expect.poll(async () => {
    const box = await board.evaluate((el) => new Promise<string>((done) => {
      const read = () => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(","); };
      const before = read();
      requestAnimationFrame(() => requestAnimationFrame(() => done(read() === before ? before : "moving")));
    }));
    const still = box !== "moving" && box === last;
    last = box;
    return still;
  }, { message: "the board is still moving" }).toBe(true);
}

/** Fit has settled: the canvas drawn at the fitted zoom, the surface unscrolled (its cards where the view puts them), every card's box still across two frames. */
async function fitted(page: Page) {
  const board = page.getByTestId("rig-graph-surface");
  await expect.poll(async () => String(Math.round((await zoomOf(page)) * 100)), { message: "the canvas is drawn at the board's zoom" }).toBe(await board.getAttribute("data-zoom"));
  expect(await board.evaluate((el) => [el.scrollLeft, el.scrollTop]), "the board's surface is not scrolled under its view").toEqual([0, 0]);
  await expect.poll(() => page.getByTestId("rig-graph").evaluate((graph) => new Promise<boolean>((done) => {
    const read = () => Array.from(graph.querySelectorAll(".pxw-graph-node")).map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(","); }).join(";");
    const before = read();
    requestAnimationFrame(() => requestAnimationFrame(() => done(read() === before)));
  })), { message: "the cards are still moving" }).toBe(true);
}

/** On a phone the Inspector is a panel over the canvas: closed to reach the board. */
async function closeOverlay(page: Page) {
  if (await page.getByTestId("panel-scrim").isVisible()) await page.getByTestId("close-inspector").click();
  await expect(page.getByTestId("panel-scrim")).toHaveCount(0);
}

const node = (page: Page, id: string) => page.getByTestId("rig-graph").locator(`.pxw-graph-node[data-node-id="${id}"]`);
/** The board at the top of its pane (a tap on Fit scrolls the pane to the controls at the board's bottom, and a phone shows a short band). */
const toBoard = (page: Page) => page.getByTestId("rig-graph-surface").evaluate((el) => el.scrollIntoView({ block: "start" }));

/** Scrolls the board's pane until a control of its bottom cluster sits above a phone's fixed tab bar. */
async function reach(page: Page, testId: string) {
  const control = page.getByTestId(testId);
  await control.scrollIntoViewIfNeeded();
  await page.evaluate((id) => {
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

/** Visible text under 12px inside one region. */
const smallTextIn = (region: Locator) =>
  region.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!(n.textContent ?? "").trim() || !el || !el.getClientRects().length) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px ${el.className || el.tagName}: ${(n.textContent ?? "").trim().slice(0, 30)}`);
    }
    return out;
  });

/** Nothing scrolls sideways: the page, or the content pane. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="content"]')))
      if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) out.push(`${el.dataset.testid} ${el.scrollWidth} > ${el.clientWidth}`);
    return out;
  });

/**
 * Text under the #7C7C84 label floor for these classes as they are on screen: its colour after its own alpha and every
 * ancestor's opacity, composited over the dark ground. A field's placeholder is read from its ::placeholder.
 */
const underFloor = (page: Page, selectors: readonly string[], placeholders: readonly string[] = []) =>
  page.evaluate(({ selectors, placeholders }) => {
    const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
    const ink = (color: string, el: Element) => {
      const [r, g, b, a = 1] = (color.match(/[\d.]+/g) ?? ["0", "0", "0"]).map(Number);
      let opacity = a;
      for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) * opacity;
    };
    const out: string[] = [];
    for (const sel of selectors) for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (!el.getClientRects().length || !(el.textContent ?? "").trim()) continue;
      const color = getComputedStyle(el).color;
      if (ink(color, el) < floor) out.push(`${sel} ${color}: “${(el.textContent ?? "").trim().slice(0, 24)}”`);
    }
    for (const sel of placeholders) for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (!el.getClientRects().length || !el.getAttribute("placeholder")) continue;
      const color = getComputedStyle(el, "::placeholder").color;
      if (ink(color, el) < floor) out.push(`${sel}::placeholder ${color}`);
    }
    return out;
  }, { selectors, placeholders });
/** Nothing on the page is still moving (a panel sliding in, a fade): colours are read as they rest. */
const settled = (page: Page) => expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity).length), { message: "animations still running" }).toBe(0);
/** Every label class the Rig draws: its list, its library strip, the shot Inspector, the canvas's cards and section titles. */
const RIG_LABELS = [
  ".pxw-rig-num", ".pxw-rig-note", ".pxw-rig-add", ".pxw-rig-library-hint",
  ".pxw-insp-output-label", ".pxw-insp-owner", ".pxw-insp-estimate-meta", ".pxw-insp-row-kind", ".pxw-insp-version-meta", ".pxw-insp-add",
  ".pxw-graph-kicker-label > *", ".pxw-graph-kicker > span:last-child", ".pxw-graph-foot > *", ".pxw-graph-desc", ".pxw-graph-note", ".pxw-graph-section-count",
] as const;

/** Real touch input: a finger drag from one point by (dx, dy) screen pixels. */
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ ...p, radiusX: 1, radiusY: 1, force: 1 })) });
async function drag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }, options: { alt?: boolean } = {}) {
  if (PHONES.includes(test.info().project.name)) {
    const cdp = await page.context().newCDPSession(page);
    await touch(cdp, "touchStart", [{ ...from, id: 1 }]);
    for (let i = 1; i <= 6; i++) await touch(cdp, "touchMove", [{ x: from.x + (by.x * i) / 6, y: from.y + (by.y * i) / 6, id: 1 }]);
    await touch(cdp, "touchEnd", []);
    await cdp.detach();
    return;
  }
  if (options.alt) await page.keyboard.down("Alt");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 6 });
  await page.mouse.up();
  if (options.alt) await page.keyboard.up("Alt");
}
/** The board's zoom exactly as the canvas is drawn at (the attribute rounds it to a percent). */
const zoomOf = (page: Page) => page.getByTestId("rig-graph").locator(".pxw-graph-canvas").evaluate((el) => Number(/scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 1));






/* ── Tidy, for everyone at once (the real local server; no live room locally, so the 5-second check carries it) ── */

async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...fixture(name, `board-${Date.now().toString(36)}`), nodes: fixture(name, "x").nodes.map((n, i) => ({ ...n, x: 1500 - i * 173, y: 90 + ((i * 257) % 900) })) };
  draft.nodes.push(shot("close", "The close", 2400, 1400));
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { draft, headers, productionId: productionProjectId };
}

async function openRig(tab: Page, draftId: string, errors: string[]) {
  await forbidPaidWork(tab);
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`/suites?suite=studio&page=rig&project=${draftId}`);
  await expect(tab.getByTestId("rig-team")).toContainText("Team canvas");
  await tab.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(tab.getByTestId("rig-graph-surface")).toBeVisible();
}

const canvasOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, CanvasNode> } | null };
/** The section titles a window shows, left to right. */
const titles = (tab: Page) => tab.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".pxw-graph-node[data-section]"))
  .sort((a, b) => Number.parseFloat(a.style.left) - Number.parseFloat(b.style.left) || Number.parseFloat(a.style.top) - Number.parseFloat(b.style.top))
  .map((el) => el.querySelector(".pxw-graph-section-name")!.textContent));
const places = (tab: Page) => tab.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>(".pxw-graph-node[data-node-id]"))
  .map((el) => [el.dataset.nodeId!, [Number.parseFloat(el.style.left), Number.parseFloat(el.style.top)]])));


test("on the phone's flow the board's section titles read as headings, each above its own cards", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the three phones: the flow is the phone's reading of the graph");
  const base = fixture("Mirror study", "ws-board").nodes;
  const nodes = [...base, section(kindSectionId("cast"), "Principal cast", 0, 0), section("sec-1", "Pickups", 0, 600), section("sec-2", "Notes", 300, 600)];
  nodes[3] = { ...nodes[3], section: "sec-1" };
  nodes[4] = { ...nodes[4], section: "sec-2" };
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const draft = { ...fixture("Mirror study", "ws-board"), nodes, productionProjectId: "prod-board", shotMappings: {} } as Project;
  await mockProjects(page, { current: draft });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workbench/engines**", (route) => route.fulfill({ json: { credits: 18, models: [] } }));
  await mockTeamCanvas(page, applyTeamPatch(emptyTeamCanvas(), { upsertNodes: nodes, removeNodes: [], upsertAssets: draft.assets, order: nodes.map((n) => n.id), at: 1 }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/workspace?project=ws-board&suite=particl&page=rig&sel=shot:open");
  await page.locator('[data-testid="mobile-page-views"] [data-view="graph"]').click();
  const flow = page.getByTestId("mobile-flow");
  await expect(flow).toBeVisible();
  /* The scene and its inputs first; then the colour card it feeds; then the rest under their titles. Cast's only card
     is read with the scene, so its title is not repeated with nothing under it. */
  const read = await flow.locator("[data-node-id]").evaluateAll((els) => els.map((el) => (el.hasAttribute("data-section") ? `# ${el.querySelector(".pxm-flow-section-name")!.textContent}` : (el as HTMLElement).dataset.nodeId)));
  expect(read).toEqual(["mira", "dunes", "board", "open", "tone", "# Pickups", "empty", "# Notes", "say"]);
  await expect(flow.locator(".pxm-flow-section")).toHaveCount(2);
  await expect(flow.locator('.pxm-flow-section:has-text("Pickups") .pxm-flow-section-count')).toHaveText("1 card");
  expect(await smallTextIn(flow), "flow text under 12px").toEqual([]);
  expect(await dimLabels(page, '[data-testid="mobile-flow"]'), "labels under #7C7C84").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no sideways scroll").toBe(true);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("rig-board-flow-390x844.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});
