import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { stableId } from "../lib/workbench/stable-id";

/**
 * Open an old board in the new Rig; nothing lost (the agentic canvas plan,
 * PR 6). An old Rig board (/rig/canvas/<board>) links to the new Rig; there
 * the board comes across onto the production's team canvas, one bounded batch
 * at a time through the server's canvas operations: every card with its kind,
 * every input as a link, every place. A second window open on the Rig sees it
 * arrive. Importing again adds nothing, and the old board reads exactly as it
 * did. Real local server (ENGINE_MOCK=1, no live room): the second window
 * folds the change in on its few-seconds check. Nothing here is paid.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const FLOOR = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;

/** An old board's card and wire, as its page saves them. */
const card = (id: string, kind: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ id, kind, x, y, label: kind, ref: null, ports: [], inputs: [], output: null, settings: {}, state: "idle", credits: 0, staleSince: null, ...extra });
const wire = (id: string, from: string, to: string, slotId: string, kind = "inherited") => ({ id, from: { nodeId: from, portId: "out" }, to: { nodeId: to, slotId }, kind });
const SLOTS = ["CHARACTER", "PROP", "BACKGROUND", "LOOK", "PROMPT"].map((label) => ({ id: label.toLowerCase(), label }));

/** The production, its Suites draft, three elements (Noor with a picture) and the old board: eight cards, six inputs and a filing line. */
async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `import-${Date.now().toString(36)}` };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = (await saved.json()) as { productionProjectId: string };
  const uploaded = await page.request.post("/api/uploads", { headers, multipart: { file: { name: "Noor.webp", mimeType: "image/webp", buffer: readFileSync("public/campaign/character.webp") } } });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const face = ((await uploaded.json()) as { id: string }).id;
  const element = async (label: string, kind: string, extra: Record<string, unknown> = {}) => {
    const made = await page.request.post("/api/rig/elements", { headers, data: { name: label, kind, projectId: productionId, ...extra } });
    expect(made.status(), await made.text()).toBe(201);
    return ((await made.json()) as { element: { id: string } }).element.id;
  };
  const noor = await element("Noor", "character", { fromUploadId: face });
  const harbour = await element("Harbour", "location");
  const bag = await element("The bag", "prop");
  const made = await page.request.post("/api/rig/boards", { data: { projectId: productionId, name: "SH04 board" } });
  expect(made.ok(), await made.text()).toBe(true);
  const boardId = ((await made.json()) as { board: { id: string } }).board.id;
  const nodes = [
    card("nd_noor", "asset", 40, 60, { label: "@Noor", ref: { elementId: noor }, settings: { kind: "character", locked: false } }),
    card("nd_harbour", "asset", 40, 420, { label: "@Harbour", ref: { elementId: harbour }, settings: { kind: "location", locked: false } }),
    card("nd_bag", "asset", 40, 780, { label: "@The bag", ref: { elementId: bag }, settings: { kind: "prop", locked: false } }),
    card("nd_shot", "shot", 380, 60, { label: "SH04", inputs: SLOTS, settings: { title: "Noor at the harbour wall", takes: 0, spent: 0 } }),
    card("nd_prompt", "prompt", 380, 480, { label: "Prompt", text: "Wind in her hair." }),
    card("nd_image", "image", 720, 60, { label: "Nano Banana Pro", ref: { engine: "gemini-3-pro-image" }, inputs: [{ id: "spec", label: "SPEC" }, { id: "refs", label: "REFS" }], settings: { resolution: "1K", ratio: "16:9", count: 1 } }),
    card("nd_compare", "compare", 1060, 60, { label: "Compare", inputs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
    card("nd_note", "note", 1060, 480, { label: "Note", text: "Keep the bag in every shot." }),
  ];
  const wires = [
    wire("w_cast", "nd_noor", "nd_shot", "character"),
    wire("w_place", "nd_harbour", "nd_shot", "background"),
    wire("w_prop", "nd_bag", "nd_shot", "prop"),
    wire("w_prompt", "nd_prompt", "nd_image", "refs"),
    wire("w_spec", "nd_shot", "nd_image", "spec"),
    wire("w_a", "nd_image", "nd_compare", "a"),
    wire("w_filed", "nd_image", "nd_shot", "takes", "filed"),
  ];
  const put = await page.request.put(`/api/rig/boards/${boardId}`, { data: { nodes, wires } });
  expect(put.ok(), await put.text()).toBe(true);
  return { draft, headers, productionId, boardId };
}

/** The new-Rig id of an old card (lib/workbench/board-import-model importedNodeId). */
const idOf = (boardId: string, nodeId: string) => stableId("node", "board", boardId, nodeId);
/** Where each card is drawn on the Rig's graph, shifted to the top-left card (lib/workspace/rig-graph graphLayout). */
const places = (tab: Page) => tab.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>(".pxw-graph-node[data-node-id]"))
  .map((el) => [el.dataset.nodeId!, [Number.parseFloat(el.style.left), Number.parseFloat(el.style.top)]])));
const expectedPlaces = (boardId: string) => Object.fromEntries(([
  ["nd_noor", 40, 60], ["nd_harbour", 40, 420], ["nd_bag", 40, 780], ["nd_shot", 380, 60], ["nd_prompt", 380, 480], ["nd_image", 720, 60], ["nd_compare", 1060, 60], ["nd_note", 1060, 480],
] as const).map(([old, x, y]) => [idOf(boardId, old), [x - 40 + 20, y - 60 + 20]]));
const edges = (tab: Page) => tab.evaluate(() => Array.from(document.querySelectorAll<SVGPathElement>("path[data-edge]")).map((p) => `${p.dataset.source}>${p.dataset.target}`).sort());
const canvasOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, CanvasNode> } | null; revision: number };
/** The canvas as its cards read: ids, places and links (a draft save may move the revision without changing any of it). */
const contentOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  Object.fromEntries(Object.entries((await canvasOf(api, headers, productionId)).canvas?.nodes ?? {}).map(([id, n]) => [id, { x: n.x, y: n.y, linked: [...n.linked].sort(), title: n.title }]));
const oldBoard = async (api: APIRequestContext, boardId: string) =>
  ((await api.get(`/api/rig/boards/${boardId}`).then((r) => r.json())) as { board: { name: string; nodes: unknown[]; wires: unknown[]; updatedAt: number; importedAt?: number | null; importedTo?: string | null } }).board;

/** One Rig window on the production's graph, joined to its team canvas. */
async function openRig(tab: Page, draftId: string, errors: string[]) {
  await forbidPaidWork(tab);
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`/suites?suite=studio&page=rig&project=${draftId}`);
  await expect(tab.getByTestId("rig-team")).toContainText("Team canvas");
  await tab.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(tab.getByTestId("rig-graph-surface")).toBeVisible();
}

/** The old board, and its link to the new Rig (a thumb-sized one on a phone). */
async function openOldBoard(tab: Page, boardId: string, errors: string[]) {
  await forbidPaidWork(tab);
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`/rig/canvas/${boardId}`);
  const link = tab.getByTestId("open-new-rig");
  await expect(link).toBeVisible({ timeout: 60_000 });
  await expect(link).toHaveText(/Open in the new Rig/);
  return link;
}

/** Nothing scrolls sideways: the page, and the Suites' content pane. */
const noSideways = (tab: Page) => tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5
  && Array.from(document.querySelectorAll<HTMLElement>('[data-testid="content"]')).every((el) => !el.getClientRects().length || el.scrollWidth <= el.clientWidth + 1));
/** The old board's row to the new Rig sits inside the screen: its button and its line end before the right edge, and it never scrolls. */
const rowFits = (tab: Page) => tab.evaluate(() => {
  const row = document.querySelector<HTMLElement>("[data-new-rig]");
  if (!row) return ["no row"];
  const out: string[] = [];
  if (row.scrollWidth > row.clientWidth + 1) out.push(`the row scrolls: ${row.scrollWidth} > ${row.clientWidth}`);
  for (const el of Array.from(row.children) as HTMLElement[]) {
    const box = el.getBoundingClientRect();
    if (box.width && box.right > window.innerWidth + 0.5) out.push(`${el.tagName} ends at ${Math.round(box.right)} past ${window.innerWidth}`);
  }
  return out;
});

/** The Rig's line about the board: readable (12px or more, above the label floor), thumb-sized buttons, above a phone's tab bar. */
async function expectReadable(tab: Page, phone: boolean) {
  const banner = tab.getByTestId("rig-import");
  const text = await banner.evaluate((root, floor) => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("p"))) {
      const style = getComputedStyle(el);
      const [r, g, b] = (style.color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
      if (0.2126 * r + 0.7152 * g + 0.0722 * b < floor) out.push(`dim: ${el.textContent}`);
      if (Number.parseFloat(style.fontSize) < 12) out.push(`small: ${el.textContent}`);
    }
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    const box = root.getBoundingClientRect();
    if (bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed" && box.bottom > bar.getBoundingClientRect().top + 1) out.push(`under the tab bar: ${box.bottom} > ${bar.getBoundingClientRect().top}`);
    return out;
  }, FLOOR);
  expect(text, "the import line's floors").toEqual([]);
  if (phone) expect(await smallTargets(tab, '[data-testid="rig-import"]'), "targets under 44×44").toEqual([]);
  expect(await noSideways(tab), "no sideways scroll").toBe(true);
}

test("an old board opens in the new Rig: every card, kind, input and place arrives, a second window sees it live, and the old board reads the same", async ({ page, context }, info) => {
  test.setTimeout(300_000);
  const phone = PHONES.includes(info.project.name);
  const { draft, headers, productionId, boardId } = await setUp(page, "Harbour import");
  const before = await oldBoard(page.request, boardId);
  expect(before.importedAt ?? null).toBeNull();
  const errors: string[] = [];
  const B = (old: string) => idOf(boardId, old);

  /* The old board links to the new Rig. */
  const link = await openOldBoard(page, boardId, errors);
  const box = (await link.boundingBox())!;
  if (phone) expect(Math.min(box.width, box.height), "the link is a thumb-sized target").toBeGreaterThanOrEqual(44 - 0.5);
  expect(await rowFits(page), "the row to the new Rig fits the screen").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5), "no sideways scroll on the old board").toBe(true);
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await page.screenshot({ path: info.outputPath(`old-board-link-${info.project.name}.png`), animations: "disabled" });

  /* A teammate's window is already on the production's Rig, with nothing on it yet. */
  const second = await context.newPage();
  await openRig(second, draft.id, errors);
  await expect.poll(() => places(second)).toEqual({});
  await link.click();

  /* It lands on this person's own draft of the production, on the Rig, bringing the board across. */
  await expect(page).toHaveURL(new RegExp(`/suites\\?.*project=${draft.id}.*`), { timeout: 60_000 });
  await expect(page).toHaveURL(new RegExp(`[?&]import=${boardId}(&|$)`));
  const banner = page.getByTestId("rig-import");
  await expect(banner).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  await expect(page.getByTestId("rig-import-line")).toHaveText("“SH04 board” is on the new Rig: 8 cards and 6 connections.");
  await expect(banner).toContainText("Filing lines stay on the old board; their takes are in Takes.");
  await expect(banner).toContainText("Free. The old board stays as it was.");
  await expectReadable(page, phone);
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await page.screenshot({ path: info.outputPath(`rig-import-done-${info.project.name}.png`), animations: "disabled" });

  /* On the graph: every card with its kind, in its old place, and every input as a link. */
  await expect(page.getByTestId("rig-graph-surface")).toBeVisible();
  await expect.poll(() => places(page)).toEqual(expectedPlaces(boardId));
  const kinds: Record<string, string> = { nd_noor: "cast", nd_harbour: "environment", nd_bag: "element" };
  for (const [old, kind] of Object.entries(kinds)) await expect(page.locator(`.pxw-graph-node[data-node-id="${B(old)}"]`)).toHaveAttribute("data-ref-kind", kind);
  const kickers: Record<string, string> = { nd_noor: "CAST", nd_shot: "SCENE", nd_prompt: "DIRECTION", nd_image: "GENERATE", nd_compare: "REVIEW", nd_note: "DIRECTION" };
  for (const [old, word] of Object.entries(kickers)) await expect(page.locator(`.pxw-graph-node[data-node-id="${B(old)}"] .pxw-graph-kicker`)).toContainText(word);
  const links = [["nd_noor", "nd_shot"], ["nd_harbour", "nd_shot"], ["nd_bag", "nd_shot"], ["nd_prompt", "nd_image"], ["nd_shot", "nd_image"], ["nd_image", "nd_compare"]].map(([a, b]) => `${B(a)}>${B(b)}`).sort();
  await expect.poll(() => edges(page)).toEqual(links);
  /* Noor's picture came with her; the shot keeps its title; the team canvas holds all of it. */
  const saved = (await canvasOf(page.request, headers, productionId)).canvas!;
  expect(Object.keys(saved.nodes).sort()).toEqual(Object.keys(expectedPlaces(boardId)).sort());
  expect(saved.nodes[B("nd_noor")]).toMatchObject({ type: "character", refKind: "cast", title: "@Noor" });
  expect(saved.nodes[B("nd_noor")].assetId).toBeTruthy();
  expect(saved.nodes[B("nd_shot")]).toMatchObject({ type: "scene", title: "SH04 — Noor at the harbour wall" });

  /* The teammate's window folds it in within a check or two, and says who changed the board. */
  await expect.poll(() => places(second), { timeout: 20_000 }).toEqual(expectedPlaces(boardId));
  await expect(second.getByTestId("rig-team-agent")).toContainText("Atomik · brought an old board across");
  await expect.poll(() => edges(second)).toEqual(links);
  if (info.project.name === "workbench-390x844") await second.screenshot({ path: info.outputPath("rig-import-second-window-390x844.png"), animations: "disabled" });

  /* Done: the line goes, and so does the board from the address. */
  await page.getByTestId("rig-import-done").click();
  await expect(banner).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]import=/);

  /* Opening it again adds nothing. */
  const settled = await contentOf(page.request, headers, productionId);
  const again = await openOldBoard(page, boardId, errors);
  await again.click();
  await expect(page.getByTestId("rig-import")).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  await expect(page.getByTestId("rig-import-line")).toHaveText("Everything on “SH04 board” is already on the new Rig. Nothing new came across.");
  expect(await contentOf(page.request, headers, productionId)).toEqual(settled);
  expect(Object.keys(settled).length).toBe(8);
  await expect.poll(() => edges(page)).toEqual(links);

  /* The old board: the same name, cards, wires and revision; only its record of the import is new. It still opens, the same. */
  const now = await oldBoard(page.request, boardId);
  expect({ name: now.name, nodes: now.nodes, wires: now.wires, updatedAt: now.updatedAt }).toEqual({ name: before.name, nodes: before.nodes, wires: before.wires, updatedAt: before.updatedAt });
  expect(now.importedTo).toBe(productionId);
  expect(now.importedAt).toBeGreaterThan(0);
  await openOldBoard(page, boardId, errors);
  if (!phone) await expect(page.getByRole("article")).toHaveCount(8);
  expect(errors).toEqual([]);
});

/** A board larger than one batch (the server brings 100 cards a call): 150 notes, each feeding the next. */
async function bigBoard(page: Page, productionId: string) {
  const made = await page.request.post("/api/rig/boards", { data: { projectId: productionId, name: "Big board" } });
  const boardId = ((await made.json()) as { board: { id: string } }).board.id;
  const nodes = Array.from({ length: 150 }, (_, i) => card(`nd_${i}`, "note", 40 + (i % 10) * 260, 60 + Math.floor(i / 10) * 180, { label: `Note ${i + 1}`, text: `Beat ${i + 1}` }));
  const wires = nodes.slice(1).map((node, i) => wire(`w_${i}`, `nd_${i}`, node.id, "text"));
  const put = await page.request.put(`/api/rig/boards/${boardId}`, { data: { nodes, wires } });
  expect(put.ok(), await put.text()).toBe(true);
  return boardId;
}

test("a board that stops part way says what came across, and Try again (free) carries on without making anything twice", async ({ page }, info) => {
  test.setTimeout(240_000);
  const phone = PHONES.includes(info.project.name);
  const { draft, headers, productionId } = await setUp(page, "Harbour retry");
  const boardId = await bigBoard(page, productionId);
  const errors: string[] = [];
  await forbidPaidWork(page);
  page.on("pageerror", (error) => errors.push(error.message));
  /* The first batch lands; the server fails the second call; after that it answers again. */
  let calls = 0, failing = true;
  await page.route(`**/api/rig/boards/${boardId}`, async (route) => {
    const request = route.request();
    const body = request.method() === "POST" ? (request.postDataJSON() as { action?: string } | null) : null;
    if (body?.action !== "import") return route.fallback();
    calls++;
    if (failing && calls === 2) return route.fulfill({ status: 503, json: { error: "The database is busy." } });
    return route.fallback();
  });
  await page.goto(`/suites?suite=studio&page=rig&project=${draft.id}&import=${boardId}`);
  const banner = page.getByTestId("rig-import");
  await expect(banner).toHaveAttribute("data-phase", "failed", { timeout: 60_000 });
  await expect(page.getByTestId("rig-import-line")).toHaveText("Part of “Big board” came across: 100 of 150 cards and 99 of 149 connections. The rest didn’t reach the new Rig.");
  await expect(banner).toContainText("Trying again is free and brings only what is missing.");
  const retry = page.getByTestId("rig-import-retry");
  await expect(retry).toHaveText("Try again");
  await expect(retry).toHaveAccessibleName("Try again, free");
  await expectReadable(page, phone);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("rig-import-partial-390x844.png"), animations: "disabled" });
  const part = await contentOf(page.request, headers, productionId);
  expect(Object.keys(part).length).toBe(100);

  /* Try again carries on from where it stopped: the other 50 cards and their links, nothing twice. */
  failing = false;
  await retry.click();
  await expect(banner).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  await expect(page.getByTestId("rig-import-line")).toHaveText("“Big board” is on the new Rig: 150 cards and 149 connections.");
  const whole = await contentOf(page.request, headers, productionId);
  expect(Object.keys(whole).length).toBe(150);
  for (const [id, before] of Object.entries(part)) expect(whole[id].x === before.x && whole[id].y === before.y, `${id} kept its place`).toBe(true);
  expect(Object.values(whole).reduce((sum, n) => sum + n.linked.length, 0)).toBe(149);
  expect(Object.values(whole).every((n) => new Set(n.linked).size === n.linked.length)).toBe(true);
  expect(await noSideways(page), "no sideways scroll").toBe(true);
  expect(errors).toEqual([]);
});

test("the import route: free, one bounded batch per call, refused for a production or board that is not here, and idempotent", async ({ page }) => {
  test.setTimeout(180_000);
  const { headers, productionId, boardId } = await setUp(page, "Harbour route");
  const post = (board: string, data: Record<string, unknown>) => page.request.post(`/api/rig/boards/${board}`, { headers, data });
  /* A production or a board that is not in this workspace: refused, and nothing is written. (A board of another production
     of this workspace is refused too, with a 409: tests/unit/boardImport.spec.ts.) */
  const nowhere = await post(boardId, { action: "import", productionId: "prj_nowhere" });
  expect(nowhere.status()).toBe(404);
  expect(((await nowhere.json()) as { error: string }).error).toBe("That project is not in this workspace.");
  expect((await post("brd_nope", { action: "import", productionId })).status()).toBe(404);
  expect((await post(boardId, { action: "tidy", productionId })).status()).toBe(400);
  /* A write needs this account's scope, like every canvas write. */
  expect((await page.request.post(`/api/rig/boards/${boardId}`, { data: { action: "import", productionId } })).status()).toBe(409);
  const first = await post(boardId, { action: "import", productionId });
  expect(first.ok(), await first.text()).toBe(true);
  expect(await first.json()).toMatchObject({ credits: 0, done: true, live: "off", filed: 1, brought: { cards: 8, wires: 6 }, cards: { total: 8, here: 8 }, wires: { total: 6, here: 6 } });
  const second = await post(boardId, { action: "import", productionId });
  expect(await second.json()).toMatchObject({ credits: 0, done: true, brought: { cards: 0, wires: 0 } });
});
