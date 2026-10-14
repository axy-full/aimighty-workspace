import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInToRedesign } from "./helpers/newInterface";
import { isCompact } from "./helpers/shellMode";
import { newProject, type Asset, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * One board, four lenses, PR 2: each stage's List shows the stage's own content as rows, the same items its Canvas draws; the beat table stays for Script, Storyboard and
 * Shots. A film with a brief, a cast, a place and a prop, three shots and a two-clip cut. The takes are made on the mock engine (free); nothing is spent on a real engine.
 * Run with LENSES_OUT=<dir> for the PR's screenshots.
 */
const OUT = process.env.LENSES_OUT || "";
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHOTS = [
  { id: "shot-a1", description: "Fog lifts off the valley.", framing: "Extreme wide", movement: "Locked off", duration: 4 },
  { id: "shot-a2", description: "A runner crests the hill.", framing: "Medium push", movement: "Slow push", duration: 6 },
  { id: "shot-a3", description: "Her breath in the cold air.", framing: "Close-up", movement: "Held", duration: 5 },
];
const node = (id: string, title: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [], ...extra });
const clip = (id: string, genId: string): Asset => ({ id, name: "Clip", kind: "video", category: "Take", url: `/api/media/${genId}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], generationId: genId, mime: "video/mp4" });

async function seed(page: Page) {
  const workspaceId = (await signInToRedesign(page.request, "Lists Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope, "Content-Type": "application/json" };
  const beats: BeatSheet = { scriptSha256: SHA, updatedAt: new Date().toISOString(), scenes: [{ id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: [], locations: [], props: [], shots: SHOTS.map((b) => ({ ...b, lighting: "", sound: "" })) }] };
  const project: Project = {
    ...newProject("Hillside film"), aspect: "16:9", fps: 24, brief: "A runner meets the dawn on an empty hillside.", direction: "Cold light, long lenses.", script: "EXT. HILLSIDE - DAWN\n\nFog lifts.",
    production: { beats },
    nodes: [
      ...SHOTS.map((b, i) => node(`node-shot000${i + 1}`, `Shot ${i + 1}`, { boardShotId: b.id })),
      node("node-cast0001", "Lead", { type: "character", refKind: "cast", text: "ivory suit" }), node("node-cast0002", "Friend", { type: "character", refKind: "cast" }),
      node("node-place001", "The hill", { type: "element", refKind: "environment" }), node("node-prop0001", "Brass bell", { type: "element", refKind: "element" }),
      node("node-note0001", "Note", { type: "note", text: "Ask about the second location." }),
    ],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const receipt = await saved.json() as { productionProjectId: string; revision?: number };
  const shotIds: string[] = [];
  for (const n of project.nodes.slice(0, 3)) {
    const mapped = await page.request.post("/api/workbench/projects", { headers, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  /* Three takes on the mock engine (free), the first two approved: the cut holds those two, the third shot waits for review. */
  const made: string[] = [];
  for (const [i, shotId] of shotIds.entries()) {
    const body = { prompt: `A frame of shot ${i + 1}`, model: "gemini-3.1-flash-image", projectId: receipt.productionProjectId, shotId, ratio: "16:9", resolution: "1K", duration: 5, refine: false, references: [] };
    const quote = await page.request.post("/api/generate/quote", { headers, data: body }).then((r) => r.json());
    const sent = await page.request.post("/api/generate", { headers: { ...headers, "Idempotency-Key": `lists-${Date.now().toString(36)}-${i}` }, data: { ...body, maxCredits: quote.estimatedCredits, quoteFingerprint: quote.fingerprint } });
    expect(sent.ok(), await sent.text()).toBe(true);
    made.push(String((await sent.json()).id));
  }
  for (const id of made) await expect.poll(async () => (await page.request.get(`/api/jobs/${id}`, { headers }).then((r) => r.json())).generation?.status, { timeout: 90_000 }).toBe("succeeded");
  for (const id of made.slice(0, 2)) {
    const approved = await page.request.patch(`/api/jobs/${id}`, { headers, data: { reviewState: "approved" } });
    expect(approved.ok(), await approved.text()).toBe(true);
  }
  const withCut: Project = { ...project, assets: [clip("a1", made[0]), clip("a2", made[1])], shots: [{ id: "c1", name: "Clip 1", assetId: "a1", duration: 120, sourceIn: 0, note: "" }, { id: "c2", name: "Clip 2", assetId: "a2", duration: 120, sourceIn: 0, note: "" }] };
  const again = await page.request.put("/api/workbench/projects", { headers, data: { project: withCut, revision: receipt.revision ?? 1 } });
  expect(again.ok(), await again.text()).toBe(true);
  await page.addInitScript(({ scope: key, id }) => { try { localStorage.setItem(key, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path.startsWith("/api/jobs") || /\/release$/.test(path))) paid.push(path);
  });
  return { project, paid };
}

const open = async (page: Page, project: Project, stage: string) => {
  await page.goto(`/suites?project=${project.id}&view=board&stage=${stage}`);
  await expect(page.getByTestId("board")).toHaveAttribute("data-stage", stage, { timeout: 90_000 });
};
const switcher = (page: Page) => page.getByTestId("v12-view-switch");
const pick = async (page: Page, view: "Canvas" | "List") => {
  await switcher(page).getByRole("radio", { name: view }).click();
  await expect(switcher(page).getByRole("radio", { name: view })).toBeChecked();
};
const rows = (page: Page) => page.getByTestId("board-stage-list-row");
/** The cards the Canvas draws: every card but a group frame, by id. */
const canvasCards = (page: Page) => page.locator("[data-card-id]:not([data-card-kind='group'])").evaluateAll((els) => els.map((el) => el.getAttribute("data-card-id")!).filter((id, i, all) => all.indexOf(id) === i).sort());
/** The cards the List names: the distinct cards its rows select. */
const listedCards = async (page: Page) => (await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-card-id")!))).filter((id, i, all) => all.indexOf(id) === i).sort();
const shot = async (page: Page, name: string) => { if (OUT) { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: `${OUT}/${name}-${page.viewportSize()?.width}x${page.viewportSize()?.height}.png` }); } };
const custom = /^(\d+)x(\d+)$/.exec(process.env.LENSES_VIEWPORT ?? "");
test.beforeEach(async ({ page }) => { if (custom) await page.setViewportSize({ width: Number(custom[1]), height: Number(custom[2]) }); });

test("Brief, Cast, Elements, Cut and Deliver: the List's rows are the cards the Canvas draws, and Script, Storyboard and Shots keep the beat table", async ({ page }, info) => {
  test.skip(isCompact(info), "the board's views are the desktop's; a phone gets its own app");
  test.setTimeout(420_000);
  const { project, paid } = await seed(page);
  for (const stage of ["brief", "cast", "elements", "cut", "deliver"]) {
    await open(page, project, stage);
    if (stage !== "deliver") await pick(page, "Canvas");
    const canvas = stage === "deliver" ? null : await canvasCards(page);
    await pick(page, "List");
    await expect(rows(page).first(), `${stage}: rows`).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("board-shotlist-row"), `${stage}: not the beat table`).toHaveCount(0);
    if (canvas) expect(await listedCards(page), `${stage}: the same cards`).toEqual(canvas);
    await shot(page, `${stage}-list`);
  }
  /* The words: the brief's fields, the cast, the elements, the clips, the specs. */
  await open(page, project, "brief");
  await expect(rows(page).filter({ hasText: "What we are making" })).toContainText("A runner meets the dawn on an empty hillside.");
  await expect(rows(page).filter({ hasText: "Format" })).toContainText("16:9 · 24 fps");
  await open(page, project, "cast");
  await expect(rows(page).filter({ hasText: "Lead" })).toContainText("ivory suit");
  await expect(rows(page).filter({ hasText: "Friend" })).toHaveCount(1);
  await open(page, project, "elements");
  await expect(rows(page).filter({ hasText: "The hill" })).toContainText("Environment");
  await expect(rows(page).filter({ hasText: "Brass bell" })).toContainText("Element");
  await open(page, project, "cut");
  await expect(rows(page).filter({ hasText: "Shot 1" })).toContainText("Approved");
  await expect(rows(page).filter({ hasText: "Shot 3" })).toContainText("Waiting");
  await open(page, project, "deliver");
  for (const spec of ["Aspect", "Frame rate", "Duration", "Loudness"]) await expect(rows(page).filter({ hasText: spec }).first()).toBeVisible();
  /* The beat table is kept where the owner said: Script, Storyboard and Shots. */
  for (const stage of ["script", "storyboard", "shots"]) {
    await open(page, project, stage);
    await pick(page, "List");
    await expect(page.getByTestId("board-shotlist-row"), `${stage}: beat table`).toHaveCount(3);
    await expect(rows(page)).toHaveCount(0);
  }
  expect(paid, "nothing spends").toEqual([]);
});
