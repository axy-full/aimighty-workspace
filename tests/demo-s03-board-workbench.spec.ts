import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { SHOTS, desktop, node, seedBoard } from "./helpers/s03-board";

/*
 * Stream 3 · the board canvas (design/particl-graphite/README.md § 1.1, § 3.1),
 * behind the new-interface switch. A production with today's canvas nodes
 * opens as a board: the outline rail, its regions arranged in bands, the
 * shared group frames, free notes where they were saved, the dot grid. Nothing
 * paid is sent. Neutral names only.
 */
test("a production opens as a board: rail, regions in bands, groups, free notes", async ({ page }, info) => {
  const { project, paid } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  if (!desktop(page)) {
    /* Phones open the project's Record (stream 10); until it lands, the board's List view, never the canvas. */
    const list = page.getByTestId("board-list");
    await expect(list.getByRole("button", { name: /Wide on the empty market/ })).toBeVisible();
    await expect(page.locator(".react-flow")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/board-${info.project.name.replace("workbench-", "")}.png` });
    return;
  }
  const board = page.getByTestId("board");
  await expect(board).toBeVisible();
  await expect(page.getByTestId("board-canvas").locator(".react-flow__node").first()).toBeVisible();

  /* The rail: seven sections, Library and History; a section with cards reads its status. */
  const rail = page.getByTestId("board-rail");
  for (const label of ["Brief", "Looks", "Storyboard", "Shots", "Cast", "Cut", "Deliver", "Library", "History"])
    await expect(rail.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();

  /* Arranged: the shots sit in the Shots frame, the cast in "Cast, environment and elements"; the note stays free. */
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  await expect(page.locator('[data-card-id="group:cast"]')).toBeVisible();
  for (const id of ["node-shot0001", "node-shot0002", "node-cast0001", "node-place001", "node-look0001", "node-brief01", "node-grade001", "node-note0001"])
    await expect(page.locator(`[data-card-id="${id}"]`)).toHaveCount(1);
  await expect(page.locator('[data-card-id="node-note0001"]')).toHaveAttribute("data-free", "true");

  /* The dot grid is an SVG pattern (README § 2; answer 4.3 Q5). */
  await expect(page.locator(".react-flow__background pattern circle")).toHaveCount(1);

  /* No horizontal overflow; nothing paid was sent. */
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/board-${info.project.name.replace("workbench-", "")}.png` });
});

test("the board's controls: glide, zoom, Board | List, a note placed and typed, lasso", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  const rail = page.getByTestId("board-rail");

  /* A rail entry glides the board there and lights it. */
  await rail.getByRole("button", { name: /^Cast/ }).click();
  await expect(rail.getByRole("button", { name: /^Cast/ })).toHaveAttribute("aria-current", "location");
  await expect(page.locator('[data-card-id="group:cast"]')).toBeInViewport();

  /* The cluster: zoom out by 10 %, back to 100 %. */
  const zoom = page.getByTestId("board-zoom");
  await page.getByTestId("board-cluster").hover();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(zoom).toHaveText("90%");
  await zoom.click();
  await expect(zoom).toHaveText("100%");

  /* Board | List: the same board as an ordered shot list; L goes back. */
  await page.getByTestId("board-list-toggle").click();
  const list = page.getByTestId("board-list");
  await expect(list).toBeVisible();
  await expect(list.getByRole("button", { name: /Opening wide|Wide on the empty market/ })).toBeVisible();
  await page.keyboard.press("l");
  await expect(list).toHaveCount(0);

  /* Note (N): placed where the canvas is pressed, typed in place, and kept. */
  await page.keyboard.press("n");
  const pane = page.locator(".react-flow__pane");
  const box = (await pane.boundingBox())!;
  await page.mouse.click(box.x + box.width - 220, box.y + box.height - 220);
  const editor = page.getByRole("textbox", { name: "Note" });
  await expect(editor).toBeFocused();
  await editor.fill("Shoot the stalls before the crowd.");
  await editor.press("Meta+Enter");
  await expect(page.locator(".bd-note-text", { hasText: "Shoot the stalls before the crowd." })).toBeVisible();

  /* Lasso: a drag on the empty canvas picks the cards it touches. */
  await rail.getByRole("button", { name: /^Shots/ }).click();
  await page.mouse.move(box.x + 20, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".bd-node[data-selected]").first()).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
});

test("an empty production opens on 'What are we making?'", async ({ page }, info) => {
  const workspaceId = (await signInLocally(page.request, "Board Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = newProject("Empty board fixture");
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await page.goto(`/suites?project=${project.id}&view=board`);
  if (!desktop(page)) {
    /* Phones: the board's List view until stream 10's Record lands; nothing wider than the screen. */
    await expect(page.getByTestId("board-list")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/board-empty-${info.project.name.replace("workbench-", "")}.png` });
    return;
  }
  const empty = page.getByTestId("board-empty");
  await expect(empty.getByRole("heading", { name: "What are we making?" })).toBeVisible();
  for (const name of ["Attach", "16:9", "9:16", "1:1", "6 s", "15 s", "30 s", "Film", "Ad campaign", "Social clips", "Start from a script"])
    await expect(empty.getByRole("button", { name, exact: true })).toBeVisible();
  /* Start waits for Atomik's seam on the board (stream 7) and never sends anything paid. */
  await expect(page.getByTestId("board-start")).toHaveAttribute("aria-disabled", "true");
  /* Aspect is the project's, carried everywhere: a press is a draft edit. */
  await empty.getByRole("button", { name: "9:16", exact: true }).click();
  await expect(empty.getByRole("button", { name: "9:16", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/board-empty-${info.project.name.replace("workbench-", "")}.png` });
});

test("the rail's drawers: Library and History, 280 px beside the rail, closed by default", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  await expect(page.getByTestId("board-library")).toHaveCount(0);
  await page.getByTestId("board-drawer-library").click();
  const library = page.getByTestId("board-library");
  await expect(library).toBeVisible();
  expect(Math.round((await library.boundingBox())!.width)).toBe(280);
  for (const name of ["All", "Images", "Video", "Audio", "Cast"]) await expect(library.getByRole("button", { name, exact: true })).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/board-library-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` });
  await page.getByTestId("board-drawer-history").click();
  await expect(page.getByTestId("board-history")).toBeVisible();
  await expect(page.getByTestId("board-library")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/board-history-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("board-history")).toHaveCount(0);
  /* A design link to frame o opens the Library drawer. */
  await page.goto(`/suites?project=${project.id}&view=board&frame=o`);
  await expect(page.getByTestId("board-library")).toBeVisible();
});

test("History reads the board's changes, with who made them, inside the workspace only", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "a read: once is enough");
  await signInLocally(page.request, "Board Tester");
  const me = await (await page.request.get("/api/me")).json() as { id: string; workspace: { id: string } };
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const nodes = [node("node-hist0001", "scene", "Opening wide", { x: 900, y: 700 }), node("node-hist0002", "scene", "The first stall", { x: 100, y: 1200 })];
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: { ...newProject("History fixture"), nodes }, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = await saved.json() as { productionProjectId: string };
  expect((await page.request.patch("/api/workbench/team-canvas", { headers, data: { productionId, upsertNodes: nodes, removeNodes: [], upsertAssets: [], order: nodes.map((n) => n.id) } })).ok()).toBe(true);
  expect((await page.request.post("/api/workbench/team-canvas", { headers, data: { action: "tidy", productionId, opId: `s03-${Date.now().toString(36)}` } })).ok()).toBe(true);

  const read = await page.request.get(`/api/workbench/team-canvas?productionId=${productionId}&history=1`, { headers });
  expect(read.ok()).toBe(true);
  const { history } = await read.json() as { history: { text: string; who: { kind: string; name: string; initials: string } }[] };
  expect(history[0]).toMatchObject({ who: { kind: "person", name: "Board Tester", initials: "BT" } });
  expect(history[0].text).toMatch(/^Tidied the board · \d+ cards? moved$/);
  /* No prices, prompts or costs in it: names, words and times only. */
  expect(JSON.stringify(history)).not.toMatch(/credit|cost|prompt|usd/i);

  /* Another workspace cannot read it. */
  const other = await browser.newContext({ baseURL: process.env.PW_BASE_URL });
  try {
    await signInLocally(other.request, "Other Tester");
    const them = await (await other.request.get("/api/me")).json() as { id: string; workspace: { id: string } };
    const theirs = await other.request.get(`/api/workbench/team-canvas?productionId=${productionId}&history=1`, { headers: { "X-Workbench-Scope": `particl-active-${them.workspace.id}-${them.id}` } });
    expect(theirs.status()).toBe(404);
  } finally {
    await other.close();
  }
  /* Signed out: refused. */
  const anon = await browser.newContext({ baseURL: process.env.PW_BASE_URL });
  try {
    expect((await anon.request.get(`/api/workbench/team-canvas?productionId=${productionId}&history=1`, { headers })).ok()).toBe(false);
  } finally {
    await anon.close();
  }
});
