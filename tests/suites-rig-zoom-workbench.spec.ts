import { test, expect, type CDPSession, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Zoom and pan on the Suites Rig canvas (owner, 2026-09-24; rebuilt from the
 * v2 change request CR1 §6). Pinch or ⌘-wheel zooms about the cursor and the
 * page never zooms or scrolls; a plain wheel or a drag on the empty board
 * pans; − / 100% / + / Fit and ⌘0 / ⌘= / ⌘- step and fit; a node dragged at
 * any zoom moves by what the pointer travelled on the board; the view is
 * remembered for the project on this device. On a phone the board fits what
 * the screen shows above the tab bar, a finger pans, two pinch, and a node
 * drag or a second finger never leaves a take stuck mid-air.
 */
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const shot = (id: string, title: string, x: number, y: number): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked: [], role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

async function open(page: Page, nodes = [shot("a", "Opening", 100, 100), shot("b", "Middle", 700, 100), shot("c", "Far", 1900, 1400)]) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = { current: { ...newProject("Zoom study"), id: "ws-zoom", productionProjectId: "prod-zoom", shotMappings: {}, nodes } as Project };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Zoom study");
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  const board = page.getByTestId("rig-graph-surface");
  await expect(board).toBeVisible();
  /* The page head reflows once the shot's price arrives (on the smallest phone it wraps a row): measure after it. */
  await expect(page.locator(".gx-pagehead")).toContainText(/Generate · \d+ cr/);
  return { board, errors, store };
}
/** A box that has stopped moving (the Inspector and the page head settle after the board appears). */
/** Scroll the board's pane until the board ends just above the tab bar, where its zoom controls are on screen. */
async function toControls(page: Page, board: Locator) {
  const band = await clearBand(page);
  await board.evaluate((el, bottom) => {
    let pane = el.parentElement;
    while (pane && !(["auto", "scroll"].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
    if (pane) pane.scrollTop += el.getBoundingClientRect().bottom - bottom;
  }, band.bottom - 12);
  return { band, box: await settled(board) };
}
async function settled(locator: Locator) {
  let last = "";
  await expect.poll(async () => {
    const b = await locator.boundingBox();
    const now = JSON.stringify(b && [b.x, b.y, b.width, b.height].map(Math.round));
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [250] }).toBe(true);
  return (await locator.boundingBox())!;
}
const node = (page: Page, id: string) => page.locator(`.pxw-graph-node[data-node-id="${id}"]`);
const pressed = (page: Page, title: string) => page.getByRole("button", { name: `Select ${title}` }).getAttribute("aria-pressed");

/** Real touch input (fingers by id; every call lists the fingers down): the path a phone takes, touch-action included. */
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ ...p, radiusX: 1, radiusY: 1, force: 1 })) });

/** What of the board's scroll pane is on screen (the nearest ancestor that really scrolls): under its top, above the phone's floating tab bar. */
const clearBand = (page: Page) => page.evaluate(() => {
  let pane = document.querySelector('[data-testid="rig-graph-surface"]')!.parentElement;
  while (pane && !(["auto", "scroll"].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
  const box = pane ? pane.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const bar = document.querySelector<HTMLElement>(".gx-tabbar");
  const barTop = bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : Infinity;
  return { top: Math.max(0, box.top), bottom: Math.min(innerHeight, box.bottom, barTop) };
});

test("⌘-wheel zooms about the cursor without zooming the page; wheel and drag pan; the cluster and keys step and fit", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "the two desktops");
  const { board, errors } = await open(page);
  await expect(board).toHaveAttribute("data-zoom", "100");
  const b = (await board.boundingBox())!;
  const a0 = (await node(page, "a").boundingBox())!;

  /* ⌘-wheel over node a's corner: zoom in, and that corner stays under the cursor. */
  const at = { x: a0.x + 10, y: a0.y + 10 };
  await page.mouse.move(at.x, at.y);
  const before = await page.evaluate(() => ({ page: window.scrollY, zoom: window.visualViewport?.scale ?? 1 }));
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(async () => Number(await board.getAttribute("data-zoom"))).toBeGreaterThan(100);
  const a1 = (await node(page, "a").boundingBox())!;
  expect(Math.abs(a1.x + 10 * (a1.width / a0.width) - at.x)).toBeLessThan(2);
  expect(Math.abs(a1.y + 10 * (a1.width / a0.width) - at.y)).toBeLessThan(2);
  expect(await page.evaluate(() => ({ page: window.scrollY, zoom: window.visualViewport?.scale ?? 1 }))).toEqual(before);

  /* 100% puts it back; + and − step by 125%. */
  await page.getByTestId("rig-zoom-level").click();
  await expect(board).toHaveAttribute("data-zoom", "100");
  await page.getByTestId("rig-zoom-in").click();
  await expect(board).toHaveAttribute("data-zoom", "125");
  await page.getByTestId("rig-zoom-out").click();
  await expect(board).toHaveAttribute("data-zoom", "100");

  /* A plain wheel pans: the content follows the gesture. */
  const p0 = (await node(page, "b").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => Math.round((await node(page, "b").boundingBox())!.y)).toBe(Math.round(p0.y - 200));

  /* A drag on the empty board pans; it does not select anything. */
  const p1 = (await node(page, "b").boundingBox())!;
  const bb = (await board.boundingBox())!;
  expect(bb.y + bb.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.mouse.move(bb.x + 20, bb.y + bb.height - 20);
  await page.mouse.down();
  await page.mouse.move(bb.x + 120, bb.y + bb.height - 70, { steps: 5 });
  await page.mouse.up();
  const p2 = (await node(page, "b").boundingBox())!;
  expect(Math.round(p2.x - p1.x)).toBe(100);
  expect(Math.round(p2.y - p1.y)).toBe(-50);

  /* Fit (and ⌘0) shows every node inside the board, never above 100%. */
  await page.getByTestId("rig-zoom-fit").click();
  const bf = (await board.boundingBox())!;
  const fitted = Number(await board.getAttribute("data-zoom"));
  expect(fitted).toBeLessThan(100);
  for (const id of ["a", "b", "c"]) {
    const n = (await node(page, id).boundingBox())!;
    expect(n.x).toBeGreaterThanOrEqual(bf.x);
    expect(n.y).toBeGreaterThanOrEqual(bf.y);
    expect(n.x + n.width).toBeLessThanOrEqual(bf.x + bf.width);
    expect(n.y + n.height).toBeLessThanOrEqual(bf.y + bf.height);
    /* …and clear of the zoom cluster. */
    const z = (await page.getByRole("group", { name: "Zoom" }).boundingBox())!;
    expect(n.x + n.width <= z.x || n.y + n.height <= z.y).toBe(true);
  }
  await page.getByTestId("rig-zoom-level").click();
  await expect(board).toHaveAttribute("data-zoom", "100");
  await page.mouse.move(bf.x + 5, bf.y + 5);
  await page.keyboard.press("ControlOrMeta+0");
  await expect(board).toHaveAttribute("data-zoom", String(fitted));
  await page.keyboard.press("ControlOrMeta+=");
  await expect.poll(async () => Number(await board.getAttribute("data-zoom"))).toBeGreaterThan(fitted);
  expect(errors).toEqual([]);
});

test("a node dragged at 200% moves by what the pointer travelled on the board, and the view is remembered", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "the two desktops");
  const { board, errors, store } = await open(page);
  const card = node(page, "b");
  /* ⌘-wheel over node b: it stays under the cursor while the board goes to 200%. */
  const b0 = (await card.boundingBox())!;
  await page.mouse.move(b0.x + 20, b0.y + 20);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect(board).toHaveAttribute("data-zoom", "200");
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 30 + 200, box.y + 20 + 100, { steps: 6 });
  await page.mouse.up();
  /* 200 px on screen at 200% is 100 board units. */
  await expect.poll(() => store.current.nodes.find((n) => n.id === "b")?.x).toBe(800);
  expect(store.current.nodes.find((n) => n.id === "b")?.y).toBe(150);
  await page.reload();
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(page.getByTestId("rig-graph-surface")).toHaveAttribute("data-zoom", "200");
  expect(errors).toEqual([]);
});

test("a node dragged off the board and let go outside it leaves the next click alone", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "the two desktops");
  const { board, errors, store } = await open(page);
  await page.getByTestId("rig-zoom-fit").click();
  /* Opening is selected when the page opens; Far is not. */
  expect(await pressed(page, "Far")).toBe("false");
  const b = await settled(node(page, "b")), bb = (await board.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width + 60, b.y + 10, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => store.current.nodes.find((n) => n.id === "b")?.x).not.toBe(700);
  /* The browser clicked outside the card for that release, so the next click is the person's own. */
  const c = (await node(page, "c").boundingBox())!;
  await page.mouse.click(c.x + c.width / 2, c.y + 10);
  await expect.poll(() => pressed(page, "Far")).toBe("true");
  expect(errors).toEqual([]);
});

test("on a phone the zoom controls scroll clear of the tab bar at 44px, a finger pans, two fingers pinch, the page never zooms", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the three phones");
  const { board, errors } = await open(page, [shot("a", "Opening", 100, 100), shot("b", "Middle", 420, 100)]);
  /* Scrolled to where it ends just above the tab bar, the board's controls are on screen and uncovered;
     where the pane shows a row of takes, the whole board is. */
  const { band, box: bb } = await toControls(page, board);
  expect(bb.y + bb.height).toBeLessThanOrEqual(band.bottom + 0.5);
  if (band.bottom - band.top >= bb.height + 12) expect(bb.y).toBeGreaterThanOrEqual(band.top - 0.5);
  for (const id of ["rig-zoom-out", "rig-zoom-level", "rig-zoom-in", "rig-zoom-fit"]) {
    const control = page.getByTestId(id), box = (await control.boundingBox())!;
    expect(Math.round(box.width * 100) / 100, id).toBeGreaterThanOrEqual(44);
    expect(Math.round(box.height * 100) / 100, id).toBeGreaterThanOrEqual(44);
    expect(await control.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), `${id} is not covered`).toBe(true);
  }
  await page.getByTestId("rig-zoom-in").tap();
  await expect(board).toHaveAttribute("data-zoom", "125");
  await page.getByTestId("rig-zoom-out").tap();
  await page.getByTestId("rig-zoom-out").tap();
  await expect(board).toHaveAttribute("data-zoom", "80");

  /* One finger on the empty board (below the takes, left of the controls) pans the board, not the pane. */
  const cdp = await page.context().newCDPSession(page);
  const pane = () => board.evaluate((el) => {
    let p = el.parentElement;
    while (p && !(["auto", "scroll"].includes(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1)) p = p.parentElement;
    return p ? p.scrollTop : scrollY;
  });
  const a0 = (await node(page, "a").boundingBox())!, scrolled = await pane();
  const empty = { x: bb.x + 10, y: bb.y + bb.height - 20 };
  await touch(cdp, "touchStart", [{ ...empty, id: 1 }]);
  for (let i = 1; i <= 5; i++) await touch(cdp, "touchMove", [{ x: empty.x + 6 * i, y: empty.y - 2 * i, id: 1 }]);
  await touch(cdp, "touchEnd", []);
  const a1 = (await node(page, "a").boundingBox())!;
  expect(Math.round(a1.x - a0.x)).toBe(30);
  expect(Math.round(a1.y - a0.y)).toBe(-10);
  expect(await pane()).toBe(scrolled);

  /* Two fingers on what shows of the board pinch it; the page itself never zooms. */
  const top = Math.max(bb.y, band.top), z0 = (await page.getByRole("group", { name: "Zoom" }).boundingBox())!;
  const mid = { x: bb.x + Math.min(bb.width / 2, z0.x - bb.x - 44), y: (top + z0.y) / 2 };
  await touch(cdp, "touchStart", [{ x: mid.x - 12, y: mid.y, id: 2 }]);
  await touch(cdp, "touchStart", [{ x: mid.x - 12, y: mid.y, id: 2 }, { x: mid.x + 12, y: mid.y, id: 3 }]);
  for (let i = 1; i <= 4; i++) await touch(cdp, "touchMove", [{ x: mid.x - 12 - 5 * i, y: mid.y, id: 2 }, { x: mid.x + 12 + 5 * i, y: mid.y, id: 3 }]);
  await touch(cdp, "touchEnd", []);
  await expect.poll(async () => Number(await board.getAttribute("data-zoom"))).toBeGreaterThan(80);
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

  /* Fit shows both takes inside the board and clear of the controls. */
  await page.getByTestId("rig-zoom-fit").tap();
  const fb = (await board.boundingBox())!, z = (await page.getByRole("group", { name: "Zoom" }).boundingBox())!;
  for (const id of ["a", "b"]) {
    const n = (await node(page, id).boundingBox())!;
    expect(n.x).toBeGreaterThanOrEqual(fb.x);
    expect(n.y).toBeGreaterThanOrEqual(fb.y);
    expect(n.x + n.width).toBeLessThanOrEqual(fb.x + fb.width);
    expect(n.y + n.height).toBeLessThanOrEqual(z.y);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("on a phone a take dragged at 51% moves by the finger's travel, the next tap selects, and a second finger cancels a drag", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the three phones");
  const { board, errors, store } = await open(page, [shot("a", "Opening", 100, 100), shot("b", "Middle", 380, 100)]);
  await toControls(page, board);
  for (let i = 0; i < 3; i++) await page.getByTestId("rig-zoom-out").tap();
  await expect(board).toHaveAttribute("data-zoom", "51");
  await board.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await settled(node(page, "a"));
  const cdp = await page.context().newCDPSession(page);

  /* 30 × 20 px on screen at 51.2% is 59 × 39 board units. */
  const a = (await node(page, "a").boundingBox())!;
  const from = { x: a.x + a.width / 2, y: a.y + 12 };
  await touch(cdp, "touchStart", [{ ...from, id: 1 }]);
  for (let i = 1; i <= 5; i++) await touch(cdp, "touchMove", [{ x: from.x + 6 * i, y: from.y + 4 * i, id: 1 }]);
  await touch(cdp, "touchEnd", []);
  await expect.poll(() => store.current.nodes.find((n) => n.id === "a")).toMatchObject({ x: 159, y: 139 });

  /* A touch drag has no click of its own, so the very next tap selects. */
  const b = (await node(page, "b").boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + 12);
  await expect.poll(() => pressed(page, "Middle")).toBe("true");

  /* A second finger mid-drag turns the gesture into a pinch: the take drops back where it was, nothing is saved. */
  const bb = (await board.boundingBox())!;
  const f = { x: b.x + b.width / 2, y: b.y + 12 }, g = { x: bb.x + bb.width / 2, y: bb.y + 8 };
  await touch(cdp, "touchStart", [{ ...f, id: 2 }]);
  for (let i = 1; i <= 3; i++) await touch(cdp, "touchMove", [{ x: f.x + 4 * i, y: f.y + 3 * i, id: 2 }]);
  await expect(node(page, "b")).toHaveAttribute("data-moving", "true");
  const f2 = { x: f.x + 12, y: f.y + 9 };
  await touch(cdp, "touchStart", [{ ...f2, id: 2 }, { ...g, id: 3 }]);
  await expect(node(page, "b")).not.toHaveAttribute("data-moving", /.*/);
  for (let i = 1; i <= 3; i++) await touch(cdp, "touchMove", [{ x: f2.x - 4 * i, y: f2.y, id: 2 }, { x: g.x + 2 * i, y: g.y, id: 3 }]);
  await touch(cdp, "touchEnd", []);
  await expect(node(page, "b")).not.toHaveAttribute("data-moving", /.*/);
  await page.waitForTimeout(1500);
  expect(store.current.nodes.find((n) => n.id === "b")).toMatchObject({ x: 380, y: 100 });
  expect(errors).toEqual([]);
});
