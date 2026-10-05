import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode, type NodeType, type Project } from "../lib/workbench/studio";
import { applyTeamPatch, emptyTeamCanvas, orderedIds, type TeamCanvas, type TeamPatch } from "../lib/workbench/team-canvas-model";
import { kindSectionId } from "../lib/workspace/rig-board";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { dimLabels } from "./phoneFloors";

/**
 * A tidier Rig board (the agentic canvas, step 2: plan PR 3). A big board
 * reads at a glance: every card shows its preview, what it is (a reference's
 * kind, a shot's type and number), its state and its version; section titles
 * group the cards; notes are written right on the board; a card let go snaps
 * to the 20 px grid (Alt places it exactly) and, let go under a section title,
 * joins that section; and Tidy lays the whole board out by sections on the
 * server, for everyone at once, making the kinds' titles it lacks. All free.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];const ENGINE = "dreamina-seedance-2-5-260628";

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








/* ── Tidy, for everyone at once (the real local server; no live room locally, so the 5-second check carries it) ── */




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
