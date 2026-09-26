import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";

/**
 * The Suites are the site on every device, and the Rig still renders the
 * workspace's list, graph and shot Inspector. On a phone the list stacks
 * instead of forcing an 800px table sideways, and the list, the graph's wiring
 * ports and the shot Inspector keep the floors: nothing under 12px, no target
 * under 44×44. With no project open the Rig asks for one; it never claims to be
 * loading.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const shot = (id: string, title: string, x: number, y: number, linked: string[] = []): CanvasNode => ({
  id, title, type: "scene", x, y, width: 238, linked, role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p",
});

async function open(page: Page, path = "/suites?suite=studio&page=rig") {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = {
    current: {
      ...newProject("Harbour at dusk"), id: "ws-rig-phone", productionProjectId: "prod-rig-phone", shotMappings: {},
      nodes: [shot("a", "The long approach across the frozen harbour", 100, 100), shot("b", "The encounter", 460, 100, ["a"]), shot("c", "Departure", 820, 100)],
    } as Project,
  };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workbench/engines**", (route) => route.fulfill({ json: { credits: 18, models: [] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Harbour at dusk");
  return errors;
}

/** Visible text under 12px inside one region. */
const smallTextIn = (region: Locator) =>
  region.evaluate((root) => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!(node.textContent ?? "").trim() || !el || !el.getClientRects().length) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px ${el.className || el.tagName}: ${(node.textContent ?? "").trim().slice(0, 30)}`);
    }
    return out;
  });

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 0.5) out.push(`page ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rig-list"], [data-testid="content"]')))
      if (el.scrollWidth > el.clientWidth + 0.5) out.push(`${el.dataset.testid} ${el.scrollWidth} > ${el.clientWidth}`);
    return out;
  });

test("phone: the shot list fits the screen (stacked when narrow), and the list and the shot Inspector keep the floors", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const errors = await open(page);
  const list = page.getByTestId("rig-list");
  await expect(list.locator(".pxw-rig-row")).toHaveCount(3);
  expect(await noSidewaysScroll(page), "sideways scroll").toEqual([]);
  /* Every row's cells stay inside the row. */
  const spill = await list.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>(".pxw-rig-row")).flatMap((row) => {
    const box = row.getBoundingClientRect();
    return Array.from(row.children).filter((child) => { const r = child.getBoundingClientRect(); return r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5); }).map((child) => (child as HTMLElement).className);
  }));
  expect(spill, "cells outside their row").toEqual([]);
  expect(await smallTextIn(list), "list text under 12px").toEqual([]);
  expect(await smallTargets(page, '[data-testid="rig-list"]'), "list targets under 44×44").toEqual([]);
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("rig-list-390x844.png"), animations: "disabled" });

  /* The shot Inspector: steppers, the play chip, Delete and every field are thumb-sized; no label under 12px. */
  await list.locator('.pxw-rig-row[data-shot-id="b"]').click();
  if (!(await page.locator('[data-inspector-body="shot"]').isVisible())) await page.getByTestId("toggle-inspector").click();
  const body = page.locator('[data-inspector-body="shot"][data-shot-id="b"]');
  await expect(body).toBeVisible();
  expect(await smallTextIn(body), "Inspector text under 12px").toEqual([]);
  expect(await smallTargets(page, '[data-inspector-body="shot"]'), "Inspector targets under 44×44").toEqual([]);
  for (const name of ["Shorter", "Longer"]) {
    const box = (await body.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  if (info.project.name === "workbench-390x844") await page.screenshot({ path: info.outputPath("rig-inspector-390x844.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("phone: the graph's wiring ports are 44px targets and its labels keep the floor", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const errors = await open(page);
  await page.locator(".gx-pagehead").getByText("Canvas", { exact: true }).click();
  await expect(page.getByTestId("rig-graph-surface")).toBeVisible();
  await page.getByTestId("rig-zoom-level").click();
  const ports = page.locator(".pxw-graph-port");
  await expect(ports.first()).toBeVisible();
  const sizes = await ports.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); }));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);
  const labels = await page.locator(".pxw-graph-kicker, .pxw-graph-foot, .pxw-graph-readouts > span").evaluateAll((els) => els.map((el) => Number.parseFloat(getComputedStyle(el).fontSize)));
  expect(Math.min(...labels)).toBeGreaterThanOrEqual(12);
  /* Wiring still works through the bigger target: out of the approach, into the departure. */
  await page.locator('.pxw-graph-node[data-node-id="a"] .pxw-graph-port--out').click();
  await expect(page.locator('.pxw-graph-node[data-node-id="a"]')).toHaveAttribute("data-wiring", /.*/);
  if (info.project.name === "workbench-390x844") await page.locator('.pxw-graph-node[data-node-id="b"]').screenshot({ path: info.outputPath("rig-graph-node-390x844.png"), animations: "disabled" });
  expect(errors).toEqual([]);
});

test("with no project open the Rig asks for one instead of loading forever", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await page.route("**/api/workbench/projects**", (route) => route.fulfill({ json: { projects: [], productions: [], project: null, revision: 0, shared: null } }));
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.goto("/workspace?suite=particl&page=rig");
  await expect(page.getByTestId("rig-list")).toContainText("Open or create a project to see its shots.");
  await expect(page.getByTestId("rig-list")).not.toContainText("Loading shots");
});
