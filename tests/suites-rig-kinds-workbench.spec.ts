import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode, type NodeType, type Project } from "../lib/workbench/studio";
import { applyTeamPatch, emptyTeamCanvas, orderedIds, type TeamCanvas, type TeamPatch } from "../lib/workbench/team-canvas-model";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * The agentic Rig, steps 1 and 2 (owner, 28 September): every reference card
 * on the Suites Rig says what it is to the production — Cast, Environment,
 * Element or Ref — on desktop and on a phone; any card can be picked; and the
 * Card Inspector sets a reference's kind for everyone on the team canvas and
 * shows the card's source, its versions and the shots it feeds. A card type a
 * newer release made draws as a plain card in a tab that is still open, and a
 * second tab open while a kind changes keeps working and keeps the kind.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const ENGINE = "dreamina-seedance-2-5-260628";

const still = (id: string, name: string, category: string, file: "hero" | "character" | "environment"): Asset => ({
  id, name, kind: "image", category, url: `/campaign/${file}.webp`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [],
});
const card = (id: string, title: string, type: NodeType, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, title, type, x, y, width: 220, linked: [], ...extra,
});
const shot = (id: string, title: string, x: number, y: number, linked: string[]): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked, role: "Director", status: "draft", mode: "Video", engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p",
});

/** Test fixtures only: a character, a place, a prop, two inputs (one locked with a kind chosen), a look board and the shot they feed. */
function fixture(name: string, id: string): Project {
  return {
    ...newProject(name), id,
    assets: [still("face", "Mira study", "Character", "character"), still("plate", "Dunes plate", "Environment", "environment"), still("prop", "Sphere turnaround", "Element", "hero"), still("frame", "Harbour still", "Reference", "hero")],
    nodes: [
      card("mira", "Mira", "character", 0, 0, { assetId: "face" }),
      card("dunes", "The mirrored dunes", "element", 0, 320, { assetId: "plate" }),
      card("sphere", "Chrome sphere", "element", 0, 640, { assetId: "prop" }),
      card("board", "Harbour board", "media", 270, 0, { assetId: "frame" }),
      card("lamp", "Desk lamp", "media", 270, 320, { assetId: "frame", refKind: "element", locked: true }),
      card("look", "Warm daylight", "moodboard", 270, 640, { text: "Warm sand. Cool chrome." }),
      shot("open", "The opening", 540, 0, ["mira", "dunes", "sphere", "board", "lamp"]),
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

/** A mocked production whose team canvas also holds `extra` (a card a newer release made, say). */
async function openMocked(page: Page, extra: CanvasNode[] = []) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const draft = { ...fixture("Mirror study", "ws-kinds"), productionProjectId: "prod-kinds", shotMappings: {} } as Project;
  const store = { current: draft };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  const nodes = [...draft.nodes, ...extra];
  const team = await mockTeamCanvas(page, applyTeamPatch(emptyTeamCanvas(), { upsertNodes: nodes, removeNodes: [], upsertAssets: draft.assets, order: nodes.map((n) => n.id), at: 1 }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Mirror study");
  await showCanvas(page);
  return { errors, store, team };
}

/**
 * The Rig's canvas, scrolled into its pane and fitted, so every card is on screen at any size. A development server
 * still compiling routes on their first use can reload the open tab, and the Rig then opens on its list, which says
 * "Team canvas" too: every step is retried together, so the canvas is shown again rather than waited on.
 */
async function showCanvas(page: Page) {
  const board = page.getByTestId("rig-graph-surface");
  await expect(async () => {
    if (!(await board.isVisible())) await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click({ timeout: 5_000 });
    await expect(board).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("rig-team")).toContainText("Team canvas", { timeout: 5_000 });
    await board.evaluate((el) => el.scrollIntoView({ block: "start" }), undefined, { timeout: 5_000 });
    await page.getByTestId("rig-zoom-fit").click({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

const node = (page: Page, id: string) => page.getByTestId("rig-graph").locator(`.pxw-graph-node[data-node-id="${id}"]`);

/**
 * Picks a card on the canvas and opens its Card Inspector. On a phone the Inspector is a panel over the canvas: it is
 * closed to reach a card, and opened to read one. The same recovery as showCanvas: every step is retried together.
 */
async function pick(page: Page, id: string) {
  const body = page.locator(`[data-inspector-body="node"][data-node-id="${id}"]`);
  await expect(async () => {
    if (await page.getByTestId("panel-scrim").isVisible()) await page.getByTestId("close-inspector").click({ timeout: 5_000 });
    await expect(page.getByTestId("panel-scrim")).toHaveCount(0, { timeout: 5_000 });
    if (!(await page.getByTestId("rig-graph-surface").isVisible())) await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click({ timeout: 5_000 });
    await page.getByTestId("rig-graph-surface").evaluate((el) => el.scrollIntoView({ block: "start" }), undefined, { timeout: 5_000 });
    await node(page, id).locator(".pxw-graph-hit").click({ timeout: 5_000 });
    await expect(node(page, id)).toHaveAttribute("data-selected", "true", { timeout: 5_000 });
    if (!(await page.getByTestId("inspector").isVisible())) await page.getByTestId("toggle-inspector").click({ timeout: 5_000 });
    await expect(body).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
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

/** Nothing scrolls sideways: the page, the content pane, the Inspector's body. */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="content"], .gx-insp-body, [data-inspector-body]')))
      if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) out.push(`${el.dataset.testid ?? el.className} ${el.scrollWidth} > ${el.clientWidth}`);
    return out;
  });

/** At the end of the Inspector's scroll, its last line sits above a floating tab bar. */
const clearsTabBar = (page: Page) =>
  page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".gx-insp-body");
    const body = document.querySelector<HTMLElement>('[data-inspector-body="node"]');
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    if (!scroller || !body || !bar || getComputedStyle(bar).position !== "fixed" || !bar.getClientRects().length) return [];
    scroller.scrollTop = scroller.scrollHeight;
    const last = Array.from(body.querySelectorAll<HTMLElement>("*")).filter((el) => el.getClientRects().length && !el.children.length).pop();
    const top = bar.getBoundingClientRect().top;
    return last && last.getBoundingClientRect().bottom > top + 1 ? [`${last.className || last.tagName} ends at ${last.getBoundingClientRect().bottom}, the tab bar starts at ${top}`] : [];
  });

test("every reference card says what it is — Cast, Environment, Element or Ref — and a card a newer release made is a plain card", async ({ page }, info) => {
  const future = { ...card("check", "Continuity check", "verify" as NodeType, 540, 380), verify: { rubric: 1 } } as CanvasNode;
  const { errors } = await openMocked(page, [future]);
  const kinds: Record<string, [string, string]> = {
    mira: ["cast", "CAST"], dunes: ["environment", "ENVIRONMENT"], sphere: ["element", "ELEMENT"], board: ["ref", "REF"], lamp: ["element", "ELEMENT"],
  };
  for (const [id, [kind, label]] of Object.entries(kinds)) {
    await expect(node(page, id)).toHaveAttribute("data-ref-kind", kind);
    await expect(node(page, id).locator(".pxw-graph-kind")).toHaveText(label);
  }
  const graph = page.getByTestId("rig-graph");
  await expect(graph.getByRole("group", { name: "Cast: Mira" })).toHaveCount(1);
  await expect(graph.getByRole("group", { name: "Environment: The mirrored dunes" })).toHaveCount(1);
  /* A look board, a shot and a card from a newer release are not references: each says what it is, and nothing breaks. */
  for (const id of ["look", "open", "check"]) await expect(node(page, id)).not.toHaveAttribute("data-ref-kind", /.*/);
  await expect(node(page, "look").locator(".pxw-graph-kicker")).toContainText("LOOK BOARD");
  await expect(node(page, "open").locator(".pxw-graph-kicker")).toContainText("SCENE");
  await expect(node(page, "check").locator(".pxw-graph-kicker")).toContainText("CARD");
  await expect(graph.getByRole("group", { name: "Card: Continuity check" })).toHaveCount(1);
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await page.getByTestId("rig-graph-surface").screenshot({ path: info.outputPath(`rig-canvas-kinds-${info.project.name}.png`), animations: "disabled" });
  /* It is never wired from a page that does not know its rules. */
  await node(page, "mira").locator(".pxw-graph-port--out").click();
  await node(page, "check").locator(".pxw-graph-port--in").click();
  await expect(graph.getByRole("status")).toHaveText("This card is from a newer version of Particl. Reload the page to connect it.");
  await page.keyboard.press("Escape");

  /* The kind is a label people read: above the floor, and 12px or more on a phone. */
  expect(await dimLabels(page, '[data-testid="rig-graph"]'), "kind labels under #7C7C84").toEqual([]);
  if (PHONES.includes(info.project.name)) {
    const sizes = await graph.locator(".pxw-graph-kind").evaluateAll((els) => els.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
  }
  expect(await sideways(page), "sideways scroll").toEqual([]);

  /* The shot the references feed says each one's kind among its inputs. */
  await pick(page, "open");
  await page.getByTestId("inspector").getByRole("button", { name: /^Inputs/ }).click();
  const inputs = page.getByTestId("rig-input").locator(".pxw-insp-row-kind");
  await expect(inputs).toHaveText(["Cast · image", "Environment · image", "Element · image", "Reference image", "Element · image"]);
  expect(await sideways(page), "sideways scroll with the shot's inputs").toEqual([]);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("rig-kinds-390x844.png"), animations: "disabled" });
  if (info.project.name === "workbench-1440x900") {
    await page.getByTestId("rig-zoom-level").click();
    await page.getByTestId("rig-graph-surface").screenshot({ path: info.outputPath("rig-canvas-100-1440x900.png"), animations: "disabled" });
  }
  expect(errors).toEqual([]);
});

test("any card can be picked; the Card Inspector sets a reference's kind for the team and shows its source, versions and the shots it feeds", async ({ page }, info) => {
  const { errors, store, team } = await openMocked(page);
  const phone = PHONES.includes(info.project.name);

  await pick(page, "board");
  await expect(page).toHaveURL(/[?&]sel=node%3Aboard(&|$)/);
  const body = page.locator('[data-inspector-body="node"][data-node-id="board"]');
  await expect(body).toBeVisible();
  await expect(body.getByTestId("inspector-title")).toHaveText("Harbour board");
  const picker = body.getByTestId("card-kind");
  await expect(picker.getByRole("button")).toHaveText(["Cast", "Environment", "Element", "Ref"]);
  await expect(picker.getByRole("button", { name: "Ref" })).toHaveAttribute("aria-pressed", "true");
  await expect(body.getByTestId("card-kind-note")).toHaveText("Read from the card until you choose one.");
  await expect(body.getByTestId("card-source")).toContainText("Harbour still");
  await expect(body.getByTestId("card-source")).toContainText("Image · Sample · Reference");
  await expect(body.getByTestId("card-versions").locator(".pxw-insp-version")).toHaveText([/v1\s*Current · Harbour still/]);
  await expect(body.getByRole("button", { name: "The opening" })).toBeVisible();
  /* The shot's Generate asks for a shot while a card is picked; nothing is sent. */
  await expect(page.locator(".gx-pagehead").getByRole("button", { name: /^Generate/ })).toBeDisabled();
  if (phone) {
    expect(await smallTextIn(body), "Card Inspector text under 12px").toEqual([]);
    expect(await smallTargets(page, '[data-inspector-body="node"]'), "Card Inspector targets under 44×44").toEqual([]);
  }
  expect(await dimLabels(page, '[data-inspector-body="node"]'), "Card Inspector labels under #7C7C84").toEqual([]);
  expect(await clearsTabBar(page), "the Card Inspector's last line under the tab bar").toEqual([]);
  expect(await sideways(page), "sideways scroll with the Card Inspector").toEqual([]);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("card-inspector-390x844.png"), animations: "disabled" });

  /* Setting the kind: the card says it at once, only that field of that card goes to the team, and the draft keeps it. */
  const before = team.patches.length;
  await picker.getByRole("button", { name: "Cast" }).click();
  await expect(picker.getByRole("button", { name: "Cast" })).toHaveAttribute("aria-pressed", "true");
  await expect(body.getByTestId("card-kind-note")).toHaveText("Set for everyone on this canvas.");
  await expect(node(page, "board")).toHaveAttribute("data-ref-kind", "cast");
  await expect(node(page, "board").locator(".pxw-graph-kind")).toHaveText("CAST");
  await expect.poll(() => team.canvas.nodes.board?.refKind).toBe("cast");
  const sent = team.patches.slice(before);
  expect(sent.flatMap((p) => Object.entries(p.fields ?? {}).filter(([, keys]) => keys.length))).toEqual([["board", ["refKind"]]]);
  expect(team.canvas.nodes.board).toMatchObject({ type: "media", assetId: "frame", x: 270, y: 0 });
  await expect.poll(() => store.current.nodes.find((n) => n.id === "board")?.refKind).toBe("cast");

  /* A locked card's kind reads, and cannot be changed. */
  await pick(page, "lamp");
  const lamp = page.locator('[data-inspector-body="node"][data-node-id="lamp"]');
  await expect(lamp.getByTestId("card-kind").getByRole("button", { name: "Element" })).toHaveAttribute("aria-pressed", "true");
  for (const button of await lamp.getByTestId("card-kind").getByRole("button").all()) await expect(button).toBeDisabled();
  await expect(lamp.getByTestId("card-kind-note")).toHaveText("Unlock this card to change its kind.");
  expect(await dimLabels(page, '[data-inspector-body="node"]'), "a locked card's labels").toEqual([]);

  /* A card that is not a reference is picked too: no kind, its type. */
  await pick(page, "look");
  const look = page.locator('[data-inspector-body="node"][data-node-id="look"]');
  await expect(look.getByTestId("inspector-title")).toHaveText("Warm daylight");
  await expect(look.getByTestId("card-kind")).toHaveCount(0);
  await expect(look).toContainText("Look board");
  await expect(look).toContainText("Nothing is attached to this card yet.");

  /* What a reference feeds is one tap away: the shot opens in the shot Inspector. */
  await pick(page, "dunes");
  await page.locator('[data-inspector-body="node"][data-node-id="dunes"]').getByRole("button", { name: "The opening" }).click();
  await expect(page.locator('[data-inspector-body="shot"][data-shot-id="open"]')).toBeVisible();
  await expect(page).toHaveURL(/[?&]sel=shot%3Aopen(&|$)/);
  await expect(node(page, "open")).toHaveAttribute("data-selected", "true");
  await expect(node(page, "dunes")).not.toHaveAttribute("data-selected", /.*/);
  expect(errors).toEqual([]);
});

test("a second tab open while a kind changes keeps working, and neither tab's kind is lost", async ({ page }, info) => {
  /* The real local server throughout: the draft save, the team canvas and the merge are the product's own. */
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft = fixture("Two tabs", `kinds-${Date.now().toString(36)}-${info.project.name.replace(/\D/g, "")}`);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  const canvas = async () => (await page.request.get(`/api/workbench/team-canvas?productionId=${productionProjectId}`, { headers }).then((r) => r.json())).canvas;
  const savedDraft = async () => (await page.request.get(`/api/workbench/projects?id=${draft.id}`, { headers }).then((r) => r.json())).project as Project;

  const url = `/suites?suite=studio&page=rig&project=${draft.id}`;
  const errors: string[] = [];
  const first = page;
  const second = await page.context().newPage();
  for (const tab of [first, second]) {
    await forbidPaidWork(tab);
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(url);
    await expect(tab.getByTestId("project-name")).toHaveText("Two tabs");
    await showCanvas(tab);
  }
  /* Both tabs are on the team canvas before anything changes. */
  await expect.poll(async () => Object.keys((await canvas())?.nodes ?? {}).sort()).toEqual(["board", "dunes", "lamp", "look", "mira", "open", "sphere"]);

  /* The first tab sets a kind. */
  await first.bringToFront();
  await pick(first, "board");
  await first.locator('[data-inspector-body="node"][data-node-id="board"]').getByTestId("card-kind").getByRole("button", { name: "Environment" }).click();
  await expect(node(first, "board")).toHaveAttribute("data-ref-kind", "environment");
  await expect.poll(async () => (await canvas())?.nodes.board?.refKind).toBe("environment");
  await expect.poll(async () => (await savedDraft()).nodes.find((n) => n.id === "board")?.refKind).toBe("environment");

  /* The second tab was open all along: it still reads the card as it was, and keeps working. */
  await second.bringToFront();
  await expect(node(second, "board")).toHaveAttribute("data-ref-kind", "ref");
  await pick(second, "sphere");
  await second.locator('[data-inspector-body="node"][data-node-id="sphere"]').getByTestId("card-kind").getByRole("button", { name: "Cast" }).click();
  await expect(node(second, "sphere")).toHaveAttribute("data-ref-kind", "cast");
  /* Its save found the first tab's newer draft and merged into it: both kinds stand, on the canvas and in the draft. */
  await expect.poll(async () => { const c = await canvas(); return [c?.nodes.board?.refKind, c?.nodes.sphere?.refKind]; }).toEqual(["environment", "cast"]);
  await expect.poll(async () => { const d = await savedDraft(); return ["board", "sphere"].map((id) => d.nodes.find((n) => n.id === id)?.refKind); }, { timeout: 20_000 }).toEqual(["environment", "cast"]);
  /* The merge brought the first tab's kind into the second. */
  await expect(node(second, "board")).toHaveAttribute("data-ref-kind", "environment", { timeout: 20_000 });

  /* The first tab, opened again, shows both. */
  await first.bringToFront();
  await first.reload();
  await expect(first.getByTestId("project-name")).toHaveText("Two tabs");
  await showCanvas(first);
  await expect(node(first, "board")).toHaveAttribute("data-ref-kind", "environment");
  await expect(node(first, "sphere")).toHaveAttribute("data-ref-kind", "cast");
  expect(await sideways(first)).toEqual([]);
  await second.close();
  expect(errors).toEqual([]);
});
