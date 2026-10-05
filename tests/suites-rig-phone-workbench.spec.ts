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

test("a shared link to a draft this person cannot open asks for a project instead of loading forever", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  /* A new teammate with no projects of their own: the named draft is not theirs, so the route answers project: null. */
  const asked: string[] = [];
  await page.route("**/api/workbench/projects**", (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("id") ?? "");
    return route.fulfill({ json: { projects: [], productions: [], project: null, revision: 0, shared: null } });
  });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.goto("/workspace?project=someone-elses-draft&suite=particl&page=rig");
  await expect.poll(() => asked.includes("someone-elses-draft")).toBe(true);
  await expect(page.getByTestId("rig-list")).toContainText("Open or create a project to see its shots.");
  await expect(page.getByTestId("rig-list")).not.toContainText("Loading shots");
});
