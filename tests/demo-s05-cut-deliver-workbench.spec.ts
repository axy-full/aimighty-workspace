import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode } from "../lib/workbench/studio";

/*
 * Stream 5 · the board's Cut and Deliver cards (design/particl-graphite/README.md § 3.1 i), behind the new-interface
 * switch. Three shots: two approved takes sit in the edit's sequence (5 s each), the third waits for review. The cut
 * says "2 approved takes · 0:10", the delivery checks read pending until the cut is complete, loudness is not
 * measured and offers no button, and Open Edit & Sound opens the existing editor over the board. Nothing paid is sent.
 */
const SHOTS = process.env.S05_SHOTS || "/private/tmp/claude-s05-shots";
const PNG = readFileSync("public/icon-192.png");

const node = (id: string, title: string): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [] }) as CanvasNode;
type Gen = Record<string, unknown> & { id: string };
const take = (id: string, shotId: string, over: Record<string, unknown> = {}): Gen => ({
  id, projectId: null, projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
  approvedBy: null, approvedAt: null, model: "gemini-3-pro-image", prompt: `Frame for ${id}`, title: `Take ${id}`, params: { resolution: "1K" },
  status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${id}`, totalTokens: null, costUsd: null, creditsBilled: 3, refineCostUsd: null,
  refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, failure: null, createdBy: "someone", authorName: "Tester",
  shotId, shotCode: null, shotScene: null, shotTitle: null, version: 1, durationMs: 20_000, durationS: null, provider: "google", attempts: 1,
  task: "generate", sourceGenId: null, createdAt: Date.now() - 600_000, updatedAt: Date.now() - 600_000, ...over,
});
const clip = (id: string, genId: string, name: string): Asset => ({ id, name, kind: "image", category: "Take", url: `/api/media/${genId}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], generationId: genId, mime: "image/png" });

async function seed(page: Page) {
  const workspaceId = (await signInLocally(page.request, "Cut Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Cut fixture"),
    brief: "A short film about a morning market opening.",
    nodes: [node("node-shot0001", "Opening wide"), node("node-shot0002", "The first stall"), node("node-shot0003", "Close on hands")],
  };
  /* The server refuses a project that names a take it does not hold, and no engine runs here: the two clips of the
     edit's sequence are put into the draft as the browser reads it, which is all the board and the editor read. */
  const sequence = {
    assets: [clip("clip-a1", "tk-s1", "Opening wide"), clip("clip-a2", "tk-s2", "The first stall")],
    shots: [
      { id: "cut-1", name: "Opening wide", assetId: "clip-a1", duration: 120, sourceIn: 0, note: "" },
      { id: "cut-2", name: "The first stall", assetId: "clip-a2", duration: 120, sourceIn: 0, note: "" },
    ],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  await page.route(/\/api\/workbench\/projects\?id=/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    try {
      const response = await route.fetch();
      const body = await response.json() as { project?: Record<string, unknown> };
      if (body.project) Object.assign(body.project, sequence);
      await route.fulfill({ response, json: body });
    } catch { /* the test ended while this read was in flight */ }
  });
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const generations: Gen[] = [
    take("tk-s1", shotIds[0], { reviewState: "approved", approvedBy: "Tester", approvedAt: Date.now() - 500_000 }),
    take("tk-s2", shotIds[1], { reviewState: "approved", approvedBy: "Tester", approvedAt: Date.now() - 400_000 }),
    take("tk-s3", shotIds[2]),
  ];
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && ((path.startsWith("/api/generate") && path !== "/api/generate/quote") || /\/release$/.test(path))) paid.push(path);
  });
  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/workbench/library?**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    if (route.request().method() !== "GET") return route.continue();
    return json(route, source === "generations" ? { generations, nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
  await page.route(/\/api\/media\/tk-/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  return { project, paid };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;

test("the cut says 2 approved takes · 0:10 with Shot 3 waiting; the checks read pending; loudness is not measured", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();

  await expect(page.locator('[data-card-id="group:cut"]').getByTestId("board-group")).toContainText("Cut and deliver");
  await expect(page.locator('[data-card-id="group:cut"]').getByTestId("board-group")).toContainText("2 approved takes · 0:10");
  const cut = page.getByTestId("cut-card");
  await expect(cut.getByTestId("cut-clip")).toHaveCount(2);
  await expect(cut.getByTestId("cut-clip")).toContainText(["Shot 1", "Shot 2"]);
  await expect(cut.getByTestId("cut-timeline")).toContainText("5 s");
  await expect(cut.getByTestId("cut-list")).toHaveText("Shot 1 · Shot 2");
  await expect(cut.getByTestId("cut-waiting")).toHaveText("Shot 3 needs review");

  const deliver = page.getByTestId("deliver-card");
  await expect(deliver.getByTestId("deliver-sub")).toHaveText("16:9 · 24 fps");
  for (const key of ["aspect", "fps", "duration"]) await expect(deliver.getByTestId(`deliver-${key}`)).toContainText("pending");
  await expect(deliver.getByTestId("deliver-duration")).toContainText("00:10");
  await expect(deliver.getByTestId("deliver-loudness")).toHaveText(/Loudness\s*Not measured/);
  await expect(deliver.getByRole("button", { name: /Measure loudness/ })).toHaveCount(0);
  await expect(deliver.getByTestId("deliver-render")).toContainText("Render master · free");
  await expect(page.locator("body")).not.toContainText(/Dune|Mira\b|Northline/);

  /* Cards are draggable: every control inside one opts out of the drag and the pan, or a press starts a drag. */
  expect(await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} input, ${sel} select, ${sel} textarea, ${sel} a`)].filter((el) => !el.closest(".nodrag")).length, "[data-testid=\"cut-card\"]")).toBe(0);
  expect(await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button, ${sel} input, ${sel} select, ${sel} textarea, ${sel} a`)].filter((el) => !el.closest(".nodrag")).length, "[data-testid=\"deliver-card\"]")).toBe(0);
  mkdirSync(SHOTS, { recursive: true });
  await page.locator('[data-region="cut"]').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/cut-deliver-${info.project.name.replace("workbench-", "")}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
});

test("Open Edit & Sound opens the existing editor over the board, and Close brings the board back; Render master opens the on-device renderer", async ({ page }, info) => {
  test.skip(!desktop(page), "phone widths open the project's Record (stream 10); the canvas is desktop only");
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  /* The rail glides the board to the Cut region (.35 s), clear of the tool pill. */
  await page.locator('[data-region="cut"]').click();
  await page.waitForTimeout(700);

  await page.getByTestId("cut-open-edit").click();
  const edit = page.getByTestId("edit-sound");
  await expect(edit).toBeVisible();
  await expect(edit.getByTestId("assembly")).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  const size = info.project.name.replace("workbench-", "");
  await page.screenshot({ path: `${SHOTS}/edit-sound-${size}.png` });
  await page.getByTestId("edit-sound-close").click();
  await expect(edit).toHaveCount(0);
  await page.getByTestId("cut-open-edit").click();
  await expect(edit).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(edit).toHaveCount(0);

  /* Render master is free and on this device: the Inspector holds the existing renderer, and the exports sit under Advanced. */
  await page.getByTestId("deliver-render").click();
  const insp = page.getByTestId("board-inspector");
  await expect(insp.getByTestId("insp-deliver")).toBeVisible();
  await expect(insp.getByTestId("insp-render")).toContainText("Final movie");
  await page.screenshot({ path: `${SHOTS}/deliver-inspector-${size}.png` });
  await insp.getByTestId("insp-advanced").click();
  await expect(insp.getByTestId("insp-export-edl")).toBeEnabled();
  await expect(insp.getByTestId("insp-export-package")).toBeEnabled();
  expect(paid).toEqual([]);
});

test("at phone widths the board is not drawn: no cut or deliver card, nothing overflows", async ({ page }) => {
  test.skip(desktop(page), "desktop widths are the two tests above");
  const { project, paid } = await seed(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("cut-card")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
});
