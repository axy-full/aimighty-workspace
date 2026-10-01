import { test, expect, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { joinLocallyAsMember, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode, type NodeType, type Project } from "../lib/workbench/studio";
import { applyTeamPatch, emptyTeamCanvas, guardMasters, orderedIds, type TeamCanvas, type TeamPatch } from "../lib/workbench/team-canvas-model";
import { CUTOUT_COPY, CUTOUT_MODEL } from "../lib/workspace/cutout";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";

/**
 * Locked masters on the Suites Rig (the agentic Rig, plan step 3) and Luma's
 * cut-out, at every size. A reference card is locked as the master from the
 * Card Inspector, free; a second tab that never heard of the lock cannot change
 * it (the server holds the edit, and the tab shows the master again); a member
 * cannot unlock it; an admin unlocks it with a reason; the lock history shows
 * both. The cut-out is priced before anything is sent, approved, and filed as
 * the card's next version with the original kept — against a mocked engine.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const ENGINE = "dreamina-seedance-2-5-260628";

const card = (id: string, title: string, type: NodeType, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title, type, x, y, width: 220, linked: [], ...extra });
const shot = (id: string, title: string, x: number, y: number, linked: string[]): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked, role: "Director", status: "draft", mode: "Video", engine: ENGINE, durationS: 5, ratio: "16:9", resolution: "720p",
});
const still = (id: string, name: string, extra: Partial<Asset> = {}): Asset => ({ id, name, kind: "image", category: "Element", url: "/campaign/hero.webp", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });

/* ── Shared helpers (as the Rig kinds spec reads the canvas and the Card Inspector) ── */

/**
 * The Rig's canvas, shown and fitted. A development server can reload an open tab while it compiles a route another
 * tab asked for, and the Rig then opens on its list: the canvas is shown again rather than waited on. Every step is
 * retried together, so a reload that lands after the canvas was first seen (the list says "Team canvas" too) shows
 * it again instead of waiting out the test on a canvas that is not there.
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
/** Picks a card on the canvas and opens its Card Inspector (the same recovery as showCanvas, step by step). */
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
  return body;
}
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
const sideways = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page ${document.documentElement.scrollWidth} > ${innerWidth}`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="content"], .gx-insp-body, [data-inspector-body]')))
      if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) out.push(`${el.dataset.testid ?? el.className} ${el.scrollWidth} > ${el.clientWidth}`);
    return out;
  });
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
/** The floors every Card Inspector state keeps: 12px text and 44px targets on a phone, labels above the floor, the last line above the tab bar, no sideways scroll. */
async function floors(page: Page, info: TestInfo, where: string) {
  const body = page.locator('[data-inspector-body="node"]');
  if (PHONES.includes(info.project.name)) {
    expect(await smallTextIn(body), `${where}: text under 12px`).toEqual([]);
    expect(await smallTargets(page, '[data-inspector-body="node"]'), `${where}: targets under 44×44`).toEqual([]);
  }
  expect(await dimLabels(page, '[data-inspector-body="node"]'), `${where}: labels under #7C7C84`).toEqual([]);
  expect(await clearsTabBar(page), `${where}: the last line under the tab bar`).toEqual([]);
  expect(await sideways(page), `${where}: sideways scroll`).toEqual([]);
}

/** A second person's browser at this project's size. */
async function contextLike(browser: Browser, info: TestInfo) {
  const use = info.project.use;
  return browser.newContext({ baseURL: process.env.PW_BASE_URL || use.baseURL, viewport: use.viewport, isMobile: use.isMobile, hasTouch: use.hasTouch });
}

test("a card is locked as the master for everyone (free); a tab that never heard of it cannot change it; a member cannot unlock it; an admin unlocks it with a reason; the history shows both", async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  /* The real local server throughout: the element route, the team canvas, its guard and the draft save are the product's own. */
  const memberContext = await contextLike(browser, info);
  const memberPage = await memberContext.newPage();
  await joinLocallyAsMember(page.request, memberPage.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  expect(me.role).toBe("admin");
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const image = await readFile("public/campaign/hero.webp");
  const upload = await page.request.post("/api/uploads", { headers, multipart: { file: { name: "Brass lamp.webp", mimeType: "image/webp", buffer: image } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  const uploaded = await upload.json() as { id: string; url: string };
  const photo = still("photo", "Brass lamp photo", { url: uploaded.url, uploadId: uploaded.id });
  const draft: Project = {
    ...newProject("Master lock"), id: `lock-${Date.now().toString(36)}-${info.project.name.replace(/\D/g, "")}`,
    assets: [photo, still("sample", "Harbour still", { category: "Reference" })],
    nodes: [card("lamp", "Brass lamp", "element", 0, 0, { assetId: "photo" }), card("board", "Harbour board", "media", 0, 320, { assetId: "sample" }), shot("open", "The opening", 270, 0, ["lamp", "board"])],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = await saved.json();
  const canvas = async () => (await page.request.get(`/api/workbench/team-canvas?productionId=${productionProjectId}`, { headers }).then((r) => r.json())) as { canvas: { nodes: Record<string, CanvasNode> } | null; locks: string[] };

  const url = `/suites?suite=studio&page=rig&project=${draft.id}`;
  const errors: string[] = [];
  const first = page;
  const second = await page.context().newPage();
  /* The second tab stands for a window that never heard of the lock (opened before it, or on the release before this
     one): its canvas reads name no masters until its own edit to one is held. So a reload of that tab by the
     development server cannot tell it early. */
  const hideLocks = { on: true };
  await second.route(/\/api\/workbench\/team-canvas\?/, async (route) => {
    if (!hideLocks.on || route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const json = await response.json().catch(() => null);
    return route.fulfill({ response, json: json && typeof json === "object" ? { ...json, locks: [] } : json });
  });
  for (const tab of [first, second]) {
    await forbidPaidWork(tab);
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(url);
    await expect(tab.getByTestId("project-name")).toHaveText("Master lock");
    await showCanvas(tab);
  }
  await expect.poll(async () => Object.keys((await canvas()).canvas?.nodes ?? {}).sort()).toEqual(["board", "lamp", "open"]);

  /* A Ref is an input, not a master: it says so, and offers no lock. */
  await first.bringToFront();
  const board = await pick(first, "board");
  await expect(board.getByTestId("card-master")).toHaveAttribute("data-master", "open");
  await expect(board.getByTestId("card-lock")).toBeDisabled();
  await expect(board.getByTestId("card-lock-note")).toHaveText("A Ref is an input, not a master. Choose Cast, Environment or Element first.");

  /* Lock the lamp as the master: free, for everyone. */
  const lamp = await pick(first, "lamp");
  await expect(lamp.getByTestId("card-master")).toHaveAttribute("data-master", "open");
  await expect(lamp.getByTestId("card-lock")).toHaveText("Lock as master · free");
  await floors(first, info, "an unlocked card");
  await lamp.getByTestId("card-lock").click();
  await expect(lamp.getByTestId("card-master")).toHaveAttribute("data-master", "locked");
  await expect(lamp.getByTestId("card-master-state")).toContainText("Locked master");
  await expect(lamp.getByTestId("card-master-state")).toContainText("Workbench Tester");
  await expect(node(first, "lamp")).toHaveAttribute("data-master", "locked");
  await expect(node(first, "lamp").locator(".pxw-graph-kind")).toHaveText("ELEMENT · MASTER");
  for (const button of await lamp.getByTestId("card-kind").getByRole("button").all()) await expect(button).toBeDisabled();
  await expect(lamp.getByTestId("card-kind-note")).toHaveText("A locked master keeps its kind.");
  await expect(lamp.getByTestId("card-lock-history").locator(".pxw-lock-event")).toHaveText([/Locked · Workbench Tester/]);
  await expect(lamp.getByTestId("card-master-check")).toHaveAttribute("data-state", "matches");
  /* A master's source stays as locked: no cut-out on it. */
  await expect(lamp.getByTestId("card-cutout-note")).toHaveText(CUTOUT_COPY.master);
  await floors(first, info, "a locked master");
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await first.screenshot({ path: info.outputPath(`card-master-${info.project.name}.png`), animations: "disabled" });
  /* The server holds it: the card on the team canvas stands for a locked element, pinned to its kind, with the lock record. */
  const locked = await canvas();
  const elementId = locked.canvas!.nodes.lamp.elementId!;
  expect(locked.locks).toEqual([elementId]);
  expect(locked.canvas!.nodes.lamp).toMatchObject({ assetId: "photo", refKind: "element", master: { elementId, lockedBy: "Workbench Tester" } });
  const lockView = await page.request.get(`/api/rig/elements/${elementId}?view=lock`).then((r) => r.json());
  expect(lockView.element).toMatchObject({ locked: true, kind: "prop" });
  expect(lockView.history.map((e: { action: string }) => e.action)).toEqual(["lock"]);
  expect(lockView.history[0].sha256).toMatch(/^[a-f0-9]{64}$/);

  /* The second tab was open all along and never heard of the lock: its edit to the master is held by the server, the rest
     of the page keeps working, and the tab shows the master as it is. */
  await second.bringToFront();
  const stale = await pick(second, "lamp");
  await expect(stale.getByTestId("card-master")).toHaveAttribute("data-master", "open");
  await stale.getByTestId("card-kind").getByRole("button", { name: "Cast" }).click();
  await expect(second.getByText("Brass lamp is a locked master: that edit did not change it. An admin can unlock a master.")).toBeVisible();
  await expect(node(second, "lamp")).toHaveAttribute("data-ref-kind", "element");
  await expect(node(second, "lamp")).toHaveAttribute("data-master", "locked");
  await expect(second.locator('[data-inspector-body="node"][data-node-id="lamp"]').getByTestId("card-master")).toHaveAttribute("data-master", "locked");
  expect((await canvas()).canvas!.nodes.lamp.refKind).toBe("element");
  hideLocks.on = false;
  /* Now it knows: the kind cannot even be pressed. */
  for (const button of await second.locator('[data-inspector-body="node"][data-node-id="lamp"]').getByTestId("card-kind").getByRole("button").all()) await expect(button).toBeDisabled();
  /* Other cards still take its edits. */
  const other = await pick(second, "board");
  await other.getByTestId("card-kind").getByRole("button", { name: "Environment" }).click();
  await expect.poll(async () => (await canvas()).canvas!.nodes.board.refKind).toBe("environment");
  await second.close();

  /* A member of the workspace sees the master and cannot unlock it: no button here, and the route refuses too. */
  const memberMe = await memberPage.request.get("/api/me").then((r) => r.json());
  const memberHeaders = { "X-Workbench-Scope": `particl-active-${memberMe.workspace.id}-${memberMe.id}` };
  const mine = { ...newProject("Master lock"), id: `member-${draft.id}`, productionProjectId, nodes: [], assets: [] };
  const memberSaved = await memberPage.request.put("/api/workbench/projects", { headers: memberHeaders, data: { project: mine, revision: 0 } });
  expect(memberSaved.ok(), await memberSaved.text()).toBe(true);
  await forbidPaidWork(memberPage);
  memberPage.on("pageerror", (error) => errors.push(error.message));
  await memberPage.goto(`/suites?suite=studio&page=rig&project=${mine.id}`);
  await expect(memberPage.getByTestId("project-name")).toHaveText("Master lock");
  await showCanvas(memberPage);
  const seen = await pick(memberPage, "lamp");
  await expect(seen.getByTestId("card-master")).toHaveAttribute("data-master", "locked");
  await expect(seen.getByTestId("card-unlock")).toHaveCount(0);
  await expect(seen.getByTestId("card-unlock-note")).toHaveText("Only an admin can unlock a master.");
  await floors(memberPage, info, "a member's view of a master");
  const refused = await memberPage.request.put(`/api/rig/elements/${elementId}`, { headers: memberHeaders, data: { locked: false, reason: "I would like to", canvas: { productionId: productionProjectId, nodeId: "lamp" } } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toBe("Only an admin can unlock a master.");
  await memberContext.close();

  /* The admin unlocks it, with a reason, which the history keeps. */
  await first.bringToFront();
  const again = await pick(first, "lamp");
  await again.getByTestId("card-unlock").click();
  await expect(again.getByTestId("card-unlock-confirm")).toBeDisabled();
  await again.getByTestId("card-unlock-reason").fill("Wrong product photo");
  await floors(first, info, "the unlock reason");
  if (info.project.name === "workbench-390x844") await first.screenshot({ path: info.outputPath("card-unlock-390x844.png"), animations: "disabled" });
  await again.getByTestId("card-unlock-confirm").click();
  await expect(again.getByTestId("card-master")).toHaveAttribute("data-master", "open");
  await expect(node(first, "lamp")).not.toHaveAttribute("data-master", /.*/);
  await expect(again.getByTestId("card-lock-history").locator(".pxw-lock-event")).toHaveText([/Unlocked · Workbench Tester · “Wrong product photo”/, /Locked · Workbench Tester/]);
  for (const button of await again.getByTestId("card-kind").getByRole("button").all()) await expect(button).toBeEnabled();
  const open = await canvas();
  expect(open.locks).toEqual([]);
  expect(open.canvas!.nodes.lamp).toMatchObject({ elementId, refKind: "element", assetId: "photo" });
  expect("master" in open.canvas!.nodes.lamp).toBe(false);
  await floors(first, info, "an unlocked card with its history");
  expect(errors).toEqual([]);
});

/* ── The cut-out, against a mocked engine and a mocked team canvas ─────── */

type Sent = { body: Record<string, unknown>; key: string | null };

async function mockTeamCanvas(page: Page, canvas: TeamCanvas, locks: string[]) {
  const store = { canvas, patches: [] as (Omit<TeamPatch, "at"> & { productionId: string })[] };
  await page.route("**/api/workbench/team-canvas**", async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { canvas: { nodes: store.canvas.nodes, assets: store.canvas.assets, order: orderedIds(store.canvas), removedIds: Object.keys(store.canvas.removed) }, revision: store.patches.length + 1, room: null, locks } });
    const body = request.postDataJSON();
    store.patches.push(body);
    /* The server's own guard, against the masters the canvas read named. */
    const guarded = guardMasters(store.canvas, { ...body, at: Date.now() }, { locks: new Set(locks) });
    store.canvas = applyTeamPatch(store.canvas, guarded.patch, "trusted");
    const held = guarded.held.map((h) => ({ ...h, ...(h.nodeId ? { node: store.canvas.nodes[h.nodeId] } : {}) }));
    return route.fulfill({ json: { revision: store.patches.length + 1, ...(held.length ? { held } : {}) } });
  });
  return store;
}

/** The mocked engine: a quote per ask (in order), the paid POST, and the job it made, running until the test lets it finish. */
async function mockEngine(page: Page, prices: number[]) {
  const seen = { quotes: [] as Record<string, unknown>[], sent: [] as Sent[], polls: 0, finish: false };
  await page.route("**/api/generate/quote", async (route) => {
    seen.quotes.push(route.request().postDataJSON());
    const credits = prices[Math.min(seen.quotes.length - 1, prices.length - 1)];
    return route.fulfill({ json: { estimatedCredits: credits, price: credits, unit: "cr", approximate: true, fingerprint: "a".repeat(64) } });
  });
  await page.route(/\/api\/generate$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    seen.sent.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] ?? null });
    return route.fulfill({ json: { id: "gen_cut1", status: "running" } });
  });
  await page.route(/\/api\/jobs\/gen_cut1(\?.*)?$/, async (route) => {
    seen.polls++;
    const done = seen.finish;
    return route.fulfill({ json: { generation: { id: "gen_cut1", kind: "image", status: done ? "succeeded" : "running", creditsBilled: done ? seen.sent.at(-1)?.body.maxCredits ?? null : null, error: null } } });
  });
  return seen;
}

async function openCutout(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  /* The 640px previews of the mocked stills (and of the cut-out) answer with a real still too. */
  const previewStill = await readFile("public/campaign/hero.webp");
  await page.route(/\/api\/workbench\/preview\/(upload|generation)\/[A-Za-z0-9_-]+(\?.*)?$/, (route) => route.fulfill({ body: previewStill, contentType: "image/webp" }));
  const photo = still("photo", "Brass lamp photo", { url: "/api/uploads/up_lamp", uploadId: "up_lamp" });
  const sphere = still("chrome", "Chrome sphere", { url: "/api/uploads/up_sphere", uploadId: "up_sphere" });
  const master = { lockedAt: "2026-09-28T10:00:00.000Z", lockedBy: "Ana", elementId: "el_sphere", versionId: "ver_1", sha256: "b".repeat(64) };
  const draft: Project = {
    ...newProject("Cut-out study"), id: "ws-cutout", productionProjectId: "prod-cutout", shotMappings: {},
    assets: [photo, sphere],
    nodes: [card("lamp", "Brass lamp", "element", 0, 0, { assetId: "photo" }), card("sphere", "Chrome sphere", "element", 0, 320, { assetId: "chrome", refKind: "element", elementId: "el_sphere", master }), shot("open", "The opening", 270, 0, ["lamp", "sphere"])],
  };
  const store = { current: draft };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  const team = await mockTeamCanvas(page, applyTeamPatch(emptyTeamCanvas(), { upsertNodes: draft.nodes, removeNodes: [], upsertAssets: draft.assets, order: draft.nodes.map((n) => n.id), at: 1 }, "trusted"), ["el_sphere"]);
  /* The sphere's lock history, as the element route answers it. */
  await page.route(/\/api\/rig\/elements\/el_sphere\?view=lock$/, (route) => route.fulfill({ json: {
    element: { id: "el_sphere", name: "Chrome sphere", kind: "prop", projectId: "prod-cutout", locked: true, lockedAt: 1 },
    history: [{ id: "ev1", action: "lock", byName: "Ana", agent: false, reason: "", at: Date.parse(master.lockedAt), sha256: master.sha256 }],
    check: { state: "matches", changes: [] },
  } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { store, team, errors };
}

test("the cut-out: priced first, nothing sent until it is approved, a moved price asked again, then filed as the card's next version with the original kept", async ({ page }, info) => {
  const { store, team, errors } = await openCutout(page);
  const engine = await mockEngine(page, [2, 3, 3]);
  await page.goto("/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Cut-out study");
  await showCanvas(page);

  /* A locked master (the canvas read names it) is marked on the canvas, and its source is not offered for a cut-out. */
  await expect(node(page, "sphere")).toHaveAttribute("data-master", "locked");
  const sphere = await pick(page, "sphere");
  await expect(sphere.getByTestId("card-master-state")).toContainText("Locked master");
  await expect(sphere.getByTestId("card-cutout-note")).toHaveText(CUTOUT_COPY.master);
  await expect(sphere.getByTestId("card-cutout-start")).toHaveCount(0);
  await expect(sphere.getByTestId("card-lock-history").locator(".pxw-lock-event")).toHaveText([/Locked · Ana/]);
  await expect(sphere.getByTestId("card-master-check")).toHaveAttribute("data-state", "matches");

  /* The lamp: cut it out. The price comes first, and asking for it is free. */
  const lamp = await pick(page, "lamp");
  await expect(lamp.getByTestId("card-cutout-start")).toHaveText("Cut out (background removal)");
  await floors(page, info, "the cut-out offer");
  await lamp.getByTestId("card-cutout-start").click();
  await expect(lamp.getByTestId("card-cutout-price")).toContainText("The cut-out costs about 2 cr, charged in credits once it is made.");
  await expect(lamp.getByTestId("card-cutout-approve")).toHaveText("Cut out · about 2 cr");
  expect(engine.sent).toHaveLength(0);
  expect(engine.quotes[0]).toMatchObject({ model: CUTOUT_MODEL, prompt: "", projectId: "prod-cutout", references: [{ uploadId: "up_lamp", role: "reference_image" }] });
  expect("maxCredits" in engine.quotes[0]).toBe(false);
  await floors(page, info, "the cut-out's price");
  if (["workbench-390x844", "workbench-1440x900"].includes(info.project.name)) await page.screenshot({ path: info.outputPath(`card-cutout-price-${info.project.name}.png`), animations: "disabled" });

  /* The price moved by the time it was pressed: nothing is sent, and the new price is asked for. */
  await lamp.getByTestId("card-cutout-approve").click();
  await expect(lamp.getByTestId("card-cutout-price")).toContainText("The price is now about 3 cr. Nothing was sent.");
  await expect(lamp.getByTestId("card-cutout-approve")).toHaveText("Cut out · about 3 cr");
  expect(engine.sent).toHaveLength(0);

  /* Approved at that price: one request, with the approved price as its ceiling, under its own key. */
  await lamp.getByTestId("card-cutout-approve").click();
  await expect.poll(() => engine.sent.length).toBe(1);
  expect(engine.sent[0].body).toMatchObject({ model: CUTOUT_MODEL, prompt: "", projectId: "prod-cutout", maxCredits: 3, quoteFingerprint: "a".repeat(64), references: [{ uploadId: "up_lamp", role: "reference_image" }] });
  expect(engine.sent[0].key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(lamp.getByTestId("card-cutout-state")).toHaveAttribute("data-phase", "running");
  await expect(lamp.getByTestId("card-cutout-state")).toContainText("about 3 cr approved");
  await floors(page, info, "the cut-out running");
  engine.finish = true;

  /* Made: the transparent version is the card's source now, the original kept below it, for everyone. */
  await expect(lamp.getByTestId("card-cutout-state")).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
  await expect(lamp.getByTestId("card-cutout-state")).toContainText("3 cr settled");
  await expect(lamp.getByTestId("card-source")).toContainText("Brass lamp photo · cut out");
  await expect(lamp.getByTestId("card-versions").locator(".pxw-insp-version")).toHaveText([/v2\s*Current · Brass lamp photo · cut out/, /v1\s*Brass lamp photo/]);
  await expect.poll(() => team.canvas.nodes.lamp?.assetId).toBe("gen_cut1");
  expect(team.canvas.assets.gen_cut1).toMatchObject({ generationId: "gen_cut1", parentId: "photo", version: 2, mime: "image/png", kind: "image" });
  expect(team.canvas.assets.photo).toMatchObject({ uploadId: "up_lamp" });
  expect(team.canvas.nodes.lamp.versions).toEqual([expect.objectContaining({ assetId: "photo", label: "Original · Brass lamp photo" })]);
  await expect.poll(() => store.current.nodes.find((n) => n.id === "lamp")?.assetId).toBe("gen_cut1");
  expect(engine.sent).toHaveLength(1);
  await floors(page, info, "the cut-out filed");
  expect(errors).toEqual([]);
});
