import { test, expect, type Page, type Locator } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { goWorkbenchStage } from "./helpers/workbenchNavigation";
import { newProject, type Project } from "../lib/workbench/studio";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Rig (workbench canvas) regression pass at every viewport: gestures release cleanly,
 * a single finger never pinches, continuous edits undo as one step, a publish clears
 * the redo path, new nodes land in view, and Space still activates canvas buttons.
 */
async function fixture(page: Page) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  let project: Project = {
    ...newProject("Rig regression"),
    id: "rig-test",
    productionProjectId: "production-rig",
    nodes: [
      { id: "a", title: "Alpha", type: "note", x: 60, y: 80, width: 150, linked: [], collapsed: true },
      { id: "b", title: "Beta", type: "note", x: 250, y: 80, width: 150, linked: ["a"], collapsed: true },
      { id: "locked", title: "Locked", type: "note", x: 60, y: 250, width: 150, linked: [], collapsed: true, locked: true },
      // Top row, right: its output port stays clear of the zoom toolbar even on the 157 px tall 844×390 canvas.
      { id: "gamma", title: "Gamma", type: "note", x: 440, y: 80, width: 150, linked: [], collapsed: true },
    ],
  };
  project.sharedNodes = [];
  project.sharedNodeIds = [];
  let revision = 1;
  let publishes = 0;
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects") {
      if (req.method() === "PUT") {
        project = req.postDataJSON().project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      if (req.method() === "POST") {
        publishes++;
        const version = (project.bibleVersion || 0) + 1;
        project = { ...project, bibleVersion: version };
        return json({
          version,
          shared: { assets: [], nodes: project.nodes.filter((n) => project.sharedNodeIds.includes(n.id)) },
        });
      }
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/jobs") return json({ generations: [] });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/workbench/engines") return json({ models: [], credits: 0 });
    if (path === "/api/productions") return json({ productions: [] });
    return json({});
  });
  await page.goto(await legacyShell(page, "/workbench"));
  await goWorkbenchStage(page, "canvas");
  await expect(page.getByLabel("Project node canvas")).toBeVisible();
  const library = page.getByRole("button", { name: "Close node library", exact: true });
  if (await library.isVisible()) await library.click();
  const inspector = page.getByRole("button", { name: "Close inspector", exact: true });
  if (await inspector.isVisible()) await inspector.click();
  await page.getByRole("button", { name: "Fit graph", exact: true }).click();
  return { current: () => project, publishes: () => publishes };
}
const canvasOf = (page: Page) => page.getByLabel("Project node canvas");
const card = (page: Page, name: string) =>
  page.getByRole("article", { name: "Direction node: " + name, exact: true });
async function point(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}
/** A viewport point inside the canvas that hits neither a node nor a control. */
async function emptyCanvasPoint(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('[aria-label="Project node canvas"]')!;
    const box = canvas.getBoundingClientRect();
    for (let fy = 0.9; fy >= 0.1; fy -= 0.1)
      for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
        const x = box.left + box.width * fx, y = box.top + box.height * fy;
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        if (el && canvas.contains(el) && !el.closest(".ng-node,button,[data-canvas-ui],.ng-canvas-bottom,.ng-wire-help,.mobile-selected-node"))
          return { x, y };
      }
    throw new Error("No empty canvas point");
  });
}
/** A viewport point outside the canvas box. */
async function outsideCanvasPoint(page: Page) {
  const box = await point(canvasOf(page));
  const size = page.viewportSize()!;
  if (box.y >= 24) return { x: box.x + box.width / 2, y: box.y - 12 };
  if (box.y + box.height + 24 <= size.height) return { x: box.x + box.width / 2, y: box.y + box.height + 12 };
  if (box.x >= 24) return { x: box.x - 12, y: box.y + box.height / 2 };
  return { x: box.x + box.width + 12, y: box.y + box.height / 2 };
}
async function syntheticPointer(page: Page, type: "pointerdown" | "pointermove" | "pointerup", at: { x: number; y: number }, pointerId: number, onBody = false) {
  await page.evaluate(({ type, at, pointerId, onBody }) => {
    const target = onBody ? document.body : (document.elementFromPoint(at.x, at.y) as Element);
    target.dispatchEvent(new PointerEvent(type, { pointerType: "touch", pointerId, isPrimary: true, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 }));
  }, { type, at, pointerId, onBody });
}
async function openNodeInspector(page: Page, name: string) {
  // Fitted nodes can be under 20 px tall at 844×390, so aim at the card's centre rather than a fixed offset.
  const target = card(page, name);
  await target.click();
  const field = page.getByRole("textbox", { name: "Node name", exact: true });
  if (!(await field.isVisible())) await target.dblclick();
  await expect(field).toBeVisible();
  return field;
}
async function leaveInspector(page: Page) {
  const sheet = page.getByRole("dialog", { name: "Node controls", exact: true });
  if (await sheet.isVisible()) await sheet.locator(".mobile-sheet-done").click();
  else {
    const close = page.getByRole("button", { name: "Close inspector", exact: true });
    if (await close.isVisible()) await close.click();
  }
  await canvasOf(page).focus();
}

test("a wire drag released outside the canvas resets the connecting state; a drop on a port connects", async ({ page }) => {
  const state = await fixture(page);
  const canvas = canvasOf(page);
  const out = await point(page.getByRole("button", { name: "Connect output from Alpha", exact: true }));
  const outside = await outsideCanvasPoint(page);
  await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2);
  await page.mouse.down();
  await page.mouse.move(outside.x, outside.y, { steps: 6 });
  await expect(canvas).toHaveClass(/ng-connecting/);
  await expect(page.locator(".ng-draft-wire")).toHaveCount(1);
  await page.mouse.up();
  await expect(canvas).not.toHaveClass(/ng-connecting/);
  await expect(page.locator(".ng-draft-wire")).toHaveCount(0);
  await expect(page.locator(".ng-wire-help")).toHaveCount(0);
  // Click mode still works: one click arms the wire, Escape cancels it.
  await page.getByRole("button", { name: "Connect output from Alpha", exact: true }).click();
  await expect(canvas).toHaveClass(/ng-connecting/);
  await canvas.press("Escape");
  await expect(canvas).not.toHaveClass(/ng-connecting/);
  // A drag from Gamma's output onto Alpha's input connects once, with no duplicate-connection error.
  const from = await point(page.getByRole("button", { name: "Connect output from Gamma", exact: true }));
  const to = await point(page.getByRole("button", { name: "Connect input to Alpha", exact: true }));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => state.current().nodes.find((n) => n.id === "a")!.linked).toEqual(["gamma"]);
  await expect(canvas).not.toHaveClass(/ng-connecting/);
  await expect(page.getByText("These nodes are already connected.")).toHaveCount(0);
});

test("a single touch after an interrupted node drag pans instead of pinching", async ({ page }) => {
  await fixture(page);
  const world = page.locator(".ng-world");
  const zoomLabel = page.getByRole("button", { name: "Fit graph", exact: true });
  const zoomBefore = await zoomLabel.textContent();
  const alpha = await point(card(page, "Alpha"));
  // A touch that starts on a node body and ends elsewhere (the node re-rendered, the sheet opened) never reached the canvas.
  await syntheticPointer(page, "pointerdown", { x: alpha.x + alpha.width / 2, y: alpha.y + alpha.height - 4 }, 41);
  await syntheticPointer(page, "pointerup", { x: alpha.x + alpha.width / 2, y: alpha.y + alpha.height - 4 }, 41, true);
  const before = await world.evaluate((el) => el.style.transform);
  const start = await emptyCanvasPoint(page);
  await syntheticPointer(page, "pointerdown", start, 42);
  for (let step = 1; step <= 5; step++)
    await syntheticPointer(page, "pointermove", { x: start.x - 12 * step, y: start.y - 8 * step }, 42);
  await syntheticPointer(page, "pointerup", { x: start.x - 60, y: start.y - 40 }, 42);
  await expect.poll(() => world.evaluate((el) => el.style.transform)).not.toBe(before);
  await expect(zoomLabel).toHaveText(zoomBefore!);
});

test("typing a name and a direction undoes as one step per field", async ({ page }) => {
  const state = await fixture(page);
  const name = await openNodeInspector(page, "Alpha");
  await name.click();
  await name.press("End");
  await name.pressSequentially(" two");
  const direction = page.getByLabel("Direction", { exact: true });
  await direction.click();
  await direction.pressSequentially("Take two");
  await expect.poll(() => state.current().nodes[0].text).toBe("Take two");
  await expect.poll(() => state.current().nodes[0].title).toBe("Alpha two");
  await leaveInspector(page);
  const undo = async () => {
    if (page.viewportSize()!.width < 760) await page.getByRole("button", { name: "Undo", exact: true }).click();
    else await canvasOf(page).press("ControlOrMeta+z");
  };
  await undo();
  await expect.poll(() => state.current().nodes[0].text ?? "").toBe("");
  expect(state.current().nodes[0].title).toBe("Alpha two");
  await undo();
  await expect.poll(() => state.current().nodes[0].title).toBe("Alpha");
  expect(state.current().nodes[0].text ?? "").toBe("");
});

test("publishing clears the redo path so redo cannot resurrect a pre-publish project", async ({ page }) => {
  test.skip(page.viewportSize()!.width < 760, "the publish control lives in the desktop command bar");
  const state = await fixture(page);
  const name = await openNodeInspector(page, "Alpha");
  await name.fill("Alpha two");
  await expect.poll(() => state.current().nodes[0].title).toBe("Alpha two");
  await leaveInspector(page);
  const canvas = canvasOf(page);
  await canvas.press("ControlOrMeta+z");
  await expect.poll(() => state.current().nodes[0].title).toBe("Alpha");
  await page.getByRole("button", { name: "Publish selected node and inputs to shared view", exact: true }).click();
  await expect.poll(() => state.publishes()).toBe(1);
  await expect.poll(() => state.current().sharedNodeIds).toEqual(["a"]);
  await canvas.focus();
  await canvas.press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(400);
  expect(state.current().nodes[0].title).toBe("Alpha");
  expect(state.current().sharedNodeIds).toEqual(["a"]);
  expect(state.current().bibleVersion).toBe(1);
  // Undo after a publish steps the local share back but keeps the server's bible version.
  await canvas.press("ControlOrMeta+z");
  await expect.poll(() => state.current().sharedNodeIds).toEqual([]);
  expect(state.current().bibleVersion).toBe(1);
});

test("a node added after panning far away lands inside the visible canvas", async ({ page }) => {
  await fixture(page);
  const canvas = canvasOf(page);
  const box = await point(canvas);
  await page.getByRole("button", { name: "Pan · H", exact: true }).click();
  for (let pass = 0; pass < 2; pass++) {
    const start = { x: box.x + 24, y: box.y + box.height * 0.45 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + box.width * 0.7, start.y + box.height * 0.3, { steps: 6 });
    await page.mouse.up();
  }
  if (page.viewportSize()!.width < 760) {
    await page.getByRole("button", { name: "Add a node", exact: true }).click();
    await page.locator('.ng-library-item[data-node-type="note"]').click();
  } else await page.getByRole("button", { name: "Add direction node", exact: true }).click();
  // The phone inspector sheet is modal and hides the canvas from the accessibility tree until it closes.
  const sheet = page.getByRole("dialog", { name: "Node controls", exact: true });
  if (await sheet.isVisible()) await sheet.locator(".mobile-sheet-done").click();
  const added = card(page, "Direction 05");
  await expect(added).toBeVisible();
  const node = await point(added);
  const visible = await point(canvas);
  expect(node.x + node.width).toBeGreaterThan(visible.x);
  expect(node.x).toBeLessThan(visible.x + visible.width);
  expect(node.y + node.height).toBeGreaterThan(visible.y);
  expect(node.y).toBeLessThan(visible.y + visible.height);
});

test("Space activates a focused canvas button instead of arming pan", async ({ page }) => {
  await fixture(page);
  const zoomLabel = page.getByRole("button", { name: "Fit graph", exact: true });
  const before = await zoomLabel.textContent();
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  await zoomIn.focus();
  await page.keyboard.press("Space");
  await expect(zoomLabel).not.toHaveText(before!);
  await expect(canvasOf(page)).not.toHaveClass(/ng-pan/);
});
