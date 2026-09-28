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

/** A mocked production on its team canvas, the Rig's canvas on screen and fitted. */
async function openMocked(page: Page, nodes?: CanvasNode[]) {
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
  await showCanvas(page);
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
  await page.getByTestId("rig-zoom-fit").click();
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

test("cards read at a glance: preview, kind or type (a shot its number), state and version; every card its shape's height; labels keep the floor", async ({ page }, info) => {
  const { errors } = await openMocked(page);
  const graph = page.getByTestId("rig-graph");
  /* Fitted, every card is on the board and clear of the add buttons at its top-left and the zoom cluster at its bottom-right. */
  const surface = (await page.getByTestId("rig-graph-surface").boundingBox())!;
  const tools = (await page.locator(".pxw-graph-tools").boundingBox())!, zoom = (await page.getByRole("group", { name: "Zoom" }).boundingBox())!;
  for (const box of await graph.locator(".pxw-graph-node").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { id: (el as HTMLElement).dataset.nodeId, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }))) {
    expect(box.x >= surface.x - 0.5 && box.right <= surface.x + surface.width + 0.5 && box.y >= surface.y - 0.5, `${box.id} is on the board`).toBe(true);
    expect(box.y >= tools.y + tools.height || box.x >= tools.x + tools.width, `${box.id} is clear of the add buttons`).toBe(true);
    expect(box.bottom <= zoom.y || box.right <= zoom.x, `${box.id} is clear of the zoom cluster`).toBe(true);
  }
  /* A reference: its kind, its version, its picture, and that it has a source. */
  await expect(node(page, "mira").locator(".pxw-graph-kind")).toHaveText("CAST");
  await expect(node(page, "mira").locator(".pxw-graph-kicker")).toContainText("v1");
  await expect(node(page, "mira").locator(".pxw-graph-media img")).toHaveCount(1);
  await expect(node(page, "mira").locator(".pxw-graph-status")).toHaveText("Ready");
  await expect(node(page, "dunes").locator(".pxw-graph-kind")).toHaveText("ENVIRONMENT");
  await expect(node(page, "empty").locator(".pxw-graph-status")).toHaveText("No source yet");
  /* A shot: its type and its number in the list, its state as the shot list reads it, its version. */
  await expect(node(page, "open").locator(".pxw-graph-kicker")).toContainText("SCENE");
  await expect(node(page, "open").locator(".pxw-graph-code")).toHaveText("01");
  await expect(node(page, "open").locator(".pxw-graph-status")).toHaveText(/^(Draft|Ready|Rendering|Approved|Failed)$/);
  await expect(node(page, "open").locator(".pxw-graph-foot")).toContainText("Director");
  /* A colour card: what it works on, and its tools. A note: its words, and the pencil that edits them. */
  await expect(node(page, "tone").locator(".pxw-graph-media")).toHaveCount(1);
  await expect(node(page, "tone").locator(".pxw-graph-foot")).toHaveText("1 active tool");
  await expect(node(page, "say").locator(".pxw-graph-note-text")).toHaveText("Hold the frame.\nLet the fabric move.");
  await expect(node(page, "say").getByRole("button", { name: "Edit note Director's note" })).toBeVisible();
  await expect(node(page, "say").locator(".pxw-graph-status")).toHaveCount(0);

  /* Every card is its shape's height (the server's Tidy lays out by it), and nothing in it spills out. */
  const shapes = await graph.locator(".pxw-graph-node").evaluateAll((els) => els.map((el) => {
    const box = el.getBoundingClientRect(), z = box.height / (el as HTMLElement).offsetHeight;
    const spill = Array.from(el.children).filter((child) => !child.matches(".pxw-graph-port, .pxw-graph-peer, .pxw-graph-hit")).some((child) => {
      const r = child.getBoundingClientRect();
      return r.height && (r.bottom > box.bottom + 0.5 * z || r.right > box.right + 0.5 * z);
    });
    return [(el as HTMLElement).dataset.nodeId, (el as HTMLElement).dataset.shape, (el as HTMLElement).offsetHeight, spill] as const;
  }));
  for (const [id, shape, height, spill] of shapes) {
    expect(height, `${id} is its shape's height`).toBe(CARD_HEIGHT[shape as keyof typeof CARD_HEIGHT]);
    expect(spill, `${id}'s contents stay inside it`).toBe(false);
  }
  expect(await dimLabels(page, '[data-testid="rig-graph"]'), "labels under #7C7C84").toEqual([]);
  if (PHONES.includes(info.project.name)) {
    await page.getByTestId("rig-zoom-level").click();
    expect(await smallTextIn(graph.locator(".pxw-graph-canvas")), "card text under 12px").toEqual([]);
    expect(await smallTargets(page, ".pxw-graph-tools"), "the add buttons under 44×44").toEqual([]);
    const pencil = (await node(page, "say").locator(".pxw-graph-edit").boundingBox())!;
    expect(Math.min(pencil.width, pencil.height), "the note's pencil is a thumb-sized target").toBeGreaterThanOrEqual(44);
  }
  expect(await sideways(page), "sideways scroll").toEqual([]);
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await page.getByTestId("rig-graph-surface").screenshot({ path: info.outputPath(`rig-board-cards-${info.project.name}.png`), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("a note is added and written right on the board, a section title is added and named there, and both reach the team canvas", async ({ page }, info) => {
  const { errors, store, team } = await openMocked(page);
  const graph = page.getByTestId("rig-graph");
  const before = new Set(Object.keys(team.canvas.nodes));

  /* A note: it opens ready to type, in the middle of what the board shows. */
  await page.getByTestId("rig-add-note").click();
  const editor = graph.getByTestId("rig-board-editor");
  await expect(editor).toBeFocused();
  if (PHONES.includes(info.project.name)) expect(Number.parseFloat(await editor.evaluate((el) => getComputedStyle(el).fontSize)), "a field never zooms a phone").toBeGreaterThanOrEqual(16);
  await editor.fill("Wide on the harbour.\nHold for four seconds.");
  await editor.press("ControlOrMeta+Enter");
  await expect(editor).toHaveCount(0);
  const noteId = await graph.locator('.pxw-graph-node[data-shape="text"]').evaluateAll((els, known) => els.map((el) => (el as HTMLElement).dataset.nodeId!).find((id) => !known.includes(id))!, [...before]);
  await expect(node(page, noteId).locator(".pxw-graph-note-text")).toHaveText("Wide on the harbour.\nHold for four seconds.");
  await expect.poll(() => team.canvas.nodes[noteId]?.text).toBe("Wide on the harbour.\nHold for four seconds.");
  expect(team.canvas.nodes[noteId]).toMatchObject({ type: "note", title: "Note" });
  expect(Math.abs(team.canvas.nodes[noteId].x % 20) + Math.abs(team.canvas.nodes[noteId].y % 20), "made on the grid").toBe(0);
  await expect.poll(() => store.current.nodes.find((n) => n.id === noteId)?.text).toBe("Wide on the harbour.\nHold for four seconds.");

  /* Its pencil opens it again; Esc leaves the words as they were. */
  await node(page, noteId).getByRole("button", { name: "Edit note Note" }).click();
  await expect(editor).toBeFocused();
  await editor.fill("Something else entirely");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(node(page, noteId).locator(".pxw-graph-note-text")).toHaveText("Wide on the harbour.\nHold for four seconds.");

  /* A section title: named on the board, Enter keeps the name. */
  await page.getByTestId("rig-add-section").click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("New section");
  await editor.fill("Scene 1 · Harbour");
  await editor.press("Enter");
  const title = graph.locator(".pxw-graph-node[data-section]");
  await expect(title).toHaveCount(1);
  await expect(title.locator(".pxw-graph-section-name")).toHaveText("Scene 1 · Harbour");
  await expect(title.locator(".pxw-graph-section-count")).toHaveText("0 cards");
  await expect(title).toHaveAttribute("aria-label", "Section: Scene 1 · Harbour");
  const titleId = (await title.getAttribute("data-node-id"))!;
  await expect.poll(() => team.canvas.nodes[titleId]?.title).toBe("Scene 1 · Harbour");
  expect(team.canvas.nodes[titleId]).toMatchObject({ type: "note", mode: "section", linked: [] });
  /* A section title is never wired: it has no ports. */
  await expect(title.locator(".pxw-graph-port")).toHaveCount(0);
  /* Renamed with its pencil. */
  await title.getByRole("button", { name: "Rename section Scene 1 · Harbour" }).click();
  await editor.fill("Scene 1 · Harbour, day");
  await editor.press("Enter");
  await expect.poll(() => team.canvas.nodes[titleId]?.title).toBe("Scene 1 · Harbour, day");
  /* An edit of words sends only the words: no edit named the cards' places. */
  expect(team.patches.flatMap((p) => Object.entries(p.fields ?? {})).filter(([id, keys]) => [titleId, noteId].includes(id) && (keys.includes("x") || keys.includes("y")))).toEqual([]);

  if (PHONES.includes(info.project.name)) {
    await page.getByTestId("rig-zoom-level").click();
    expect(await smallTargets(page, ".pxw-graph-tools"), "the add buttons under 44×44").toEqual([]);
    const pencil = (await title.locator(".pxw-graph-edit").boundingBox())!;
    expect(Math.min(pencil.width, pencil.height)).toBeGreaterThanOrEqual(44);
  }
  expect(await dimLabels(page, '[data-testid="rig-graph"]'), "labels under #7C7C84").toEqual([]);
  expect(await sideways(page), "sideways scroll").toEqual([]);
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await page.getByTestId("rig-graph-surface").screenshot({ path: info.outputPath(`rig-board-note-${info.project.name}.png`), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("a card let go snaps to the 20 px grid (Alt places it exactly), and let go under a section title it joins that section", async ({ page }, info) => {
  /* One row, so a phone's short board shows it all when fitted. */
  const nodes = [section("sec-1", "Scene 1 · Harbour", 0, 0), card("board", "Harbour board", "media", 330, 30, { assetId: "frame" }), card("empty", "Pickup plate", "media", 640, 0)];
  const { errors, team } = await openMocked(page, nodes);
  const moved = (id: string) => team.patches.flatMap((p) => p.upsertNodes).filter((n) => n.id === id).at(-1);

  /* Dragged by an odd amount: it lands on the grid, within a grid step of where the pointer let it go. */
  await toBoard(page);
  const zoom = await zoomOf(page);
  const b = (await node(page, "board").boundingBox())!;
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: 37, y: 23 });
  await expect.poll(() => moved("board")?.x).toBeDefined();
  const landed = moved("board")!;
  expect([Math.abs(landed.x % 20), Math.abs(landed.y % 20)]).toEqual([0, 0]);
  expect(Math.abs(landed.x - (330 + 37 / zoom))).toBeLessThanOrEqual(11);
  expect(Math.abs(landed.y - (30 + 23 / zoom))).toBeLessThanOrEqual(11);
  /* It was let go under no title: it is filed nowhere. */
  expect(team.canvas.nodes.board.section).toBeUndefined();

  if (DESKTOPS.includes(info.project.name)) {
    /* With Alt held it lands exactly where it was let go: off the grid, by what the pointer travelled on the board. */
    const c = (await node(page, "board").boundingBox())!;
    const before = team.patches.length;
    await drag(page, { x: c.x + c.width / 2, y: c.y + c.height / 2 }, { x: 37, y: 23 }, { alt: true });
    await expect.poll(() => team.patches.length).toBeGreaterThan(before);
    expect([team.canvas.nodes.board.x, team.canvas.nodes.board.y]).toEqual([landed.x + Math.round(37 / zoom), landed.y + Math.round(23 / zoom)]);
  }

  /* Let go just under the section's title, the pickup joins that section: the title counts it, the team has it. */
  await (await reach(page, "rig-zoom-fit")).click();
  await toBoard(page);
  const t = (await node(page, "sec-1").boundingBox())!, e = (await node(page, "empty").boundingBox())!;
  const grab = { x: e.x + e.width / 2, y: e.y + e.height / 2 };
  /* The pickup's top-left goes just under the title's: its grab point moves with it. */
  await drag(page, grab, { x: t.x + 8 - e.x, y: t.y + t.height + 24 - e.y });
  await expect.poll(() => team.canvas.nodes.empty?.section).toBe("sec-1");
  await expect(node(page, "sec-1").locator(".pxw-graph-section-count")).toHaveText("1 card");
  expect([team.canvas.nodes.empty.x % 20, team.canvas.nodes.empty.y % 20]).toEqual([0, 0]);
  /* A card let go is not a click: nothing got picked by the drag. */
  await expect(node(page, "empty")).not.toHaveAttribute("data-selected", /.*/);
  expect(await sideways(page), "sideways scroll").toEqual([]);
  expect(errors).toEqual([]);
});

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

test("Tidy lays the board out by sections for everyone: the other window folds it in, titles and all, and a second press moves nothing", async ({ page, context }, info) => {
  const { draft, headers, productionId } = await setUp(page, "Board tidy");
  const errors: string[] = [];
  const second = await context.newPage();
  await openRig(page, draft.id, errors);
  await openRig(second, draft.id, errors);
  await expect.poll(async () => Object.keys((await canvasOf(page.request, headers, productionId)).canvas?.nodes ?? {}).length).toBe(8);
  for (const tab of [page, second]) await expect(tab.locator(".pxw-graph-node[data-section]")).toHaveCount(0);

  const tidy = await reach(page, "rig-tidy");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, ".pxw-graph-zoom"), "zoom cluster targets under 44×44").toEqual([]);
  await tidy.click();
  /* Seven cards, eight with the close; six kinds: Cast, Environment, Refs (the plate and the pickup), Direction, Shots, Finishing. */
  await expect(page.getByTestId("rig-graph")).toContainText("Tidied for everyone · 8 cards moved · 6 sections added · free");
  const order = ["Cast", "Environment", "Refs", "Direction", "Shots", "Finishing"];
  await expect.poll(() => titles(page)).toEqual(order);
  /* The other window folds the same board in within a check or two, and says who changed it. */
  await expect.poll(() => titles(second), { timeout: 15_000 }).toEqual(order);
  await expect.poll(async () => JSON.stringify(await places(second)), { timeout: 15_000 }).toBe(JSON.stringify(await places(page)));
  await expect(second.getByTestId("rig-team-agent")).toContainText("Atomik · tidied the board");

  /* The team canvas: each kind's block left to right on the 20 px grid, shots down their column in canvas order. */
  const nodes = (await canvasOf(page.request, headers, productionId)).canvas!.nodes;
  const at = (id: string) => [nodes[id].x, nodes[id].y];
  expect([at("mira"), at("dunes"), at("board"), at("empty"), at("say"), at("open"), at("close"), at("tone")]).toEqual([
    [60, 140], [420, 140], [780, 140], [780, 380], [1140, 140], [1500, 140], [1500, 400], [1860, 140],
  ]);
  expect([nodes[kindSectionId("cast")], nodes[kindSectionId("shots")]].map((t) => [t.title, t.mode, t.x, t.y])).toEqual([["Cast", "section", 60, 60], ["Shots", "section", 1500, 60]]);
  expect(nodes[kindSectionId("ref")].title).toBe("Refs");
  /* The section titles count their cards, and keep the floors. */
  await expect(second.locator(`.pxw-graph-node[data-node-id="${kindSectionId("ref")}"] .pxw-graph-section-count`)).toHaveText("2 cards");
  expect(await dimLabels(second, '[data-testid="rig-graph"]'), "labels under #7C7C84").toEqual([]);

  /* A second press: nothing left to move, nothing to add. */
  await (await reach(page, "rig-tidy")).click();
  await expect(page.getByTestId("rig-graph")).toContainText("Already tidy · nothing moved");
  for (const tab of [page, second]) expect(await sideways(tab), "sideways scroll").toEqual([]);
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) {
    await second.getByTestId("rig-zoom-fit").click();
    await second.getByTestId("rig-graph-surface").screenshot({ path: info.outputPath(`rig-board-tidied-${info.project.name}.png`), animations: "disabled" });
  }
  expect(errors).toEqual([]);
});

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
