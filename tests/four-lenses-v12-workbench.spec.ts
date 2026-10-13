import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { signInToRedesign } from "./helpers/newInterface";
import { isCompact } from "./helpers/shellMode";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * One board, four lenses (owner, 13 Oct; docs/redesign-plan.md): every view of a stage shows the SAME content of that stage, arranged differently, and no view is
 * empty while another has items. Script opens in List, Storyboard / Shots / Cast / Elements / Cut in Canvas; a person's own switch is remembered per board and per
 * stage, and moving between stages never resets it. Nothing is sent or spent: the takes are the library's, answered in the browser.
 * Run with LENSES_OUT=<dir> for the PR's screenshots.
 */
const OUT = process.env.LENSES_OUT || "";
const PNG = readFileSync("public/icon-192.png");
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const BEATS = [
  { id: "shot-a1", description: "Fog lifts off the valley.", framing: "Extreme wide", movement: "Locked off · 24mm", duration: 4 },
  { id: "shot-a2", description: "A runner crests the hill.", framing: "Medium push", movement: "Slow push · 35mm", duration: 6 },
  { id: "shot-a3", description: "Her breath in the cold air.", framing: "Close-up", movement: "Held · 85mm", duration: 5 },
];
const SCRIPT = "EXT. HILLSIDE - DAWN\n\nFog lifts off the valley. A runner crests the hill. Her breath in the cold air.";
const sheet = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: new Date().toISOString(),
  scenes: [{ id: "scene-a", heading: "EXT. HILLSIDE - DAWN", summary: "", beats: [], characters: [], locations: [], props: [], shots: BEATS.map((b) => ({ ...b, lighting: "", sound: "" })) }],
});
const node = (id: string, title: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [], ...extra });

type Gen = Record<string, unknown> & { id: string };
const take = (id: string, shotId: string): Gen => ({
  id, projectId: null, projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null, approvedBy: null, approvedAt: null,
  model: "gemini-3-pro-image", prompt: `Frame for ${id}`, title: `Take ${id}`, params: { resolution: "1K" }, status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${id}`,
  totalTokens: null, costUsd: null, creditsBilled: 3, refineCostUsd: null, refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, failure: null,
  createdBy: "someone", authorName: "Tester", shotId, shotCode: null, shotScene: null, shotTitle: null, version: 1, durationMs: 20_000, durationS: null, provider: "google",
  attempts: 1, task: "generate", sourceGenId: null, createdAt: Date.now() - 600_000, updatedAt: Date.now() - 600_000,
});

/** A film board with a script, a beat sheet of three shots, a shot card for each (linked to its beat) and, when asked, a take on the first. */
async function seed(page: Page, { beats = true, taken = false }: { beats?: boolean; taken?: boolean } = {}) {
  const workspaceId = (await signInToRedesign(page.request, "Lenses Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project: Project = {
    ...newProject("Hillside film"), aspect: "16:9", fps: 24, brief: "A runner meets the dawn on an empty hillside.", direction: "Cold light, long lenses.",
    ...(beats ? { script: SCRIPT, production: { beats: sheet() } } : {}),
    nodes: BEATS.map((b, i) => node(`node-shot000${i + 1}`, `Shot ${i + 1}`, beats ? { boardShotId: b.id } : {})),
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  await page.addInitScript(({ scope: key, id }) => { try { localStorage.setItem(key, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const generations: Gen[] = taken ? [take("tk-l1", shotIds[0])] : [];
  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/workbench/library?**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, new URL(route.request().url()).searchParams.get("source") === "generations" ? { generations, nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
  await page.route(/\/api\/media\/tk-/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path.startsWith("/api/jobs") || /\/release$/.test(path))) paid.push(path);
  });
  return { project, scope, paid };
}

const open = async (page: Page, project: Project, stage: string) => {
  await page.goto(`/suites?project=${project.id}&view=board&stage=${stage}`);
  await expect(page.getByTestId("board")).toHaveAttribute("data-stage", stage, { timeout: 90_000 });
};
const switcher = (page: Page) => page.getByTestId("v12-view-switch");
const pick = async (page: Page, view: "Canvas" | "List" | "Rig") => {
  await switcher(page).getByRole("radio", { name: view }).click();
  await expect(switcher(page).getByRole("radio", { name: view })).toBeChecked();
};
const current = (page: Page) => switcher(page).getByRole("radio", { checked: true });
/** What the List shows: the beat-sheet table's rows, or the plain list's. */
const listRows = (page: Page) => page.locator('[data-testid="board-shotlist-row"], [data-testid="board-list"] button.bd-list-row');
const shot = async (page: Page, name: string, size: string) => { if (OUT) { mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: `${OUT}/${name}-${size}.png` }); } };
const size = (page: Page) => `${page.viewportSize()?.width}x${page.viewportSize()?.height}`;
/** LENSES_VIEWPORT=1280x800 reads the same boards at another desktop size (the PR's screenshots). */
const custom = /^(\d+)x(\d+)$/.exec(process.env.LENSES_VIEWPORT ?? "");
test.beforeEach(async ({ page }) => { if (custom) await page.setViewportSize({ width: Number(custom[1]), height: Number(custom[2]) }); });

const PHONE_APP = "the board's views are the desktop's; a phone gets its own app";

test("Script opens in List with a row per beat; Canvas shows the script and the same beats in the same order", async ({ page }, info) => {
  test.skip(isCompact(info), PHONE_APP);
  test.setTimeout(240_000);
  const { project, paid } = await seed(page);
  await open(page, project, "script");
  await expect(current(page)).toHaveAccessibleName("List");
  await expect(listRows(page)).toHaveCount(3);
  /* A row's words are its cells' (fields): the beat's description, in the beat sheet's order. */
  const listed = await listRows(page).evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("textarea")].map((t) => (t as HTMLTextAreaElement).value).join(" ")));
  for (const [i, beat] of BEATS.entries()) expect(listed[i], `row ${i + 1}`).toContain(beat.description);
  await shot(page, "script-list", size(page));

  await pick(page, "Canvas");
  const beatCards = page.locator('[data-card-id^="beat:"]');
  await expect(beatCards).toHaveCount(3);
  await expect(page.locator('[data-card-id="doc:script"]')).toBeVisible();
  await expect(page.locator('[data-card-id="doc:script"]').getByTestId("board-script-text")).toHaveValue(SCRIPT);
  /* The same beats, in the beat sheet's order. */
  expect(await beatCards.evaluateAll((els) => els.map((el) => el.getAttribute("data-card-id")))).toEqual(BEATS.map((b) => `beat:${b.id}`));
  for (const [i, beat] of BEATS.entries()) await expect(beatCards.nth(i).getByTestId("board-beat-text")).toHaveValue(beat.description);
  /* Nothing sits under the others: no overlap between the cards. */
  const boxes = await page.locator('[data-card-id="doc:script"], [data-card-id^="beat:"]').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    expect(a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1 || a.y + a.h <= b.y + 1 || b.y + b.h <= a.y + 1, `cards ${i} and ${j} do not overlap`).toBe(true);
  }
  await shot(page, "script-canvas", size(page));
  /* A beat edited on its card is the row the List shows. */
  await beatCards.nth(1).getByTestId("board-beat-text").fill("A runner crests the hill at speed.");
  await beatCards.nth(1).getByTestId("board-beat-text").blur();
  await pick(page, "List");
  await expect(listRows(page).nth(1)).toContainText("A runner crests the hill at speed.", { timeout: 20_000 });
  expect(paid, "nothing spends").toEqual([]);
});

test("a person's switch is remembered for that stage on that board; moving between stages and gliding never resets it", async ({ page }, info) => {
  test.skip(isCompact(info), PHONE_APP);
  test.setTimeout(240_000);
  const { project, scope } = await seed(page);
  /* Defaults: Script List; Storyboard, Shots, Cast, Elements and Cut Canvas. */
  await open(page, project, "script");
  await expect(current(page)).toHaveAccessibleName("List");
  for (const stage of ["storyboard", "shots", "cast", "elements", "cut"]) {
    await open(page, project, stage);
    await expect(current(page), `${stage} opens in Canvas`).toHaveAccessibleName("Canvas");
  }
  /* Script to Canvas, Storyboard to List: each is kept while the person moves about. */
  await open(page, project, "script");
  await pick(page, "Canvas");
  await open(page, project, "storyboard");
  await pick(page, "List");
  await open(page, project, "shots");
  await expect(current(page)).toHaveAccessibleName("Canvas");
  await open(page, project, "script");
  await expect(current(page)).toHaveAccessibleName("Canvas");
  await open(page, project, "storyboard");
  await expect(current(page)).toHaveAccessibleName("List");
  /* A row's number selects its card and glides to it: the List stays where the person left it. */
  await page.locator(".gx-shotlist-n").first().click();
  await expect(current(page)).toHaveAccessibleName("List");
  /* Kept on this device, under the board's own key, by stage. */
  expect(await page.evaluate(([s, p]) => JSON.parse(localStorage.getItem(`board-lens:${s}:${p}`) ?? "null"), [scope, project.id])).toEqual({ script: "canvas", storyboard: "list" });
  await page.reload();
  await expect(page.getByTestId("board")).toHaveAttribute("data-stage", "storyboard", { timeout: 90_000 });
  await expect(current(page)).toHaveAccessibleName("List");
  await open(page, project, "script");
  await expect(current(page)).toHaveAccessibleName("Canvas");
});

test("Storyboard keeps its frames after the first take; Canvas and List both show a shot each", async ({ page }, info) => {
  test.skip(isCompact(info), PHONE_APP);
  test.setTimeout(240_000);
  const { project, paid } = await seed(page, { taken: true });
  await open(page, project, "storyboard");
  await expect(page.locator('[data-card-kind="frame"]')).toHaveCount(3, { timeout: 60_000 });
  await shot(page, "storyboard-after-take", size(page));
  await pick(page, "List");
  await expect(listRows(page)).toHaveCount(3);
  /* The Shots stage draws the shots (a card each), and its List the same three. */
  await open(page, project, "shots");
  await expect(page.locator('[data-card-kind="take"]')).toHaveCount(3, { timeout: 60_000 });
  await expect(page.locator('[data-card-kind="frame"]')).toHaveCount(0);
  await pick(page, "List");
  await expect(listRows(page)).toHaveCount(3);
  expect(paid, "nothing spends").toEqual([]);
});

test("Shots' List lists the board's shots when there is no beat sheet, as many as the Canvas has", async ({ page }, info) => {
  test.skip(isCompact(info), PHONE_APP);
  test.setTimeout(240_000);
  const { project } = await seed(page, { beats: false });
  await open(page, project, "shots");
  await expect(page.locator('[data-card-kind="take"]')).toHaveCount(3, { timeout: 60_000 });
  await pick(page, "List");
  await expect(listRows(page)).toHaveCount(3);
  await expect(page.getByTestId("v12-stage-empty")).toHaveCount(0);
});

test("a stage with nothing yet shows the same empty message in Canvas, List and Rig, and the List lists no beats there", async ({ page }, info) => {
  test.skip(isCompact(info), PHONE_APP);
  test.setTimeout(240_000);
  const { project } = await seed(page);
  /* Elements: a film with a script and beats but no elements. */
  await open(page, project, "elements");
  await expect(page.getByTestId("v12-stage-empty")).toBeVisible({ timeout: 60_000 });
  const words = await page.getByTestId("v12-stage-empty").innerText();
  for (const view of ["List", "Rig", "Canvas"] as const) {
    await pick(page, view);
    await expect(page.getByTestId("v12-stage-empty"), `${view}`).toBeVisible();
    expect(await page.getByTestId("v12-stage-empty").innerText(), `${view}`).toBe(words);
    await expect(listRows(page), `${view}: no beats on an empty stage`).toHaveCount(0);
  }
});
