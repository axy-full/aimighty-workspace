import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { BeatSheet } from "../lib/production/beats";

/*
 * Board cards 1 · the looks (README § 3.1 c) and "Where to next?" (§ 3.1 j), behind the new-interface switch.
 * Looks come from the draft (`production.boards.looks`; pictures answered in the browser: no engine, no stored
 * generation); picking one is free and saves itself. Once every shot has an approved take (the project library,
 * answered in the browser), three cards offer a next make: each opens Make or Crew, where the price is shown and a
 * person presses. Nothing paid is ever sent. Neutral names only.
 */
const SHOTS = process.env.S04_SHOTS || "/private/tmp/claude-s04-shots";
const PNG = readFileSync("public/icon-192.png");
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NOW = new Date().toISOString();

const beats = (): BeatSheet => ({
  scriptSha256: SHA, updatedAt: NOW,
  scenes: [{
    id: "scene-a", heading: "EXT. PIER - DAWN", summary: "", beats: [], characters: [], locations: [], props: [],
    shots: [
      { id: "shot-a1", description: "Mist over the water.", framing: "Extreme wide", movement: "Locked off · 24mm", lighting: "", sound: "", duration: 5 },
      { id: "shot-a2", description: "A figure on the pier.", framing: "Medium", movement: "Slow push · 35mm", lighting: "", sound: "", duration: 5 },
    ],
  }],
});
const shotNode = (id: string, title: string, boardShotId: string): CanvasNode => ({
  id, title, type: "scene", x: 0, y: 0, width: 344, linked: [], boardShotId, role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "1080p",
});
const look = (name: string, genId: string) => ({ name, prompt: `A still frame from this film. Look: ${name}.`, takes: [{ genId, at: NOW }], selected: genId });

type Gen = Record<string, unknown> & { id: string };
const take = (id: string, shotId: string, over: Record<string, unknown> = {}): Gen => ({
  id, projectId: null, projectName: null, arkTaskId: null, kind: "video", reviewState: "approved", reviewBy: "Tester", pickedBy: null, pickedAt: null,
  approvedBy: "Tester", approvedAt: Date.now() - 500_000, model: "dreamina-seedance-2-5-260628", prompt: `Take ${id}`, title: `Take ${id}`,
  params: { duration: 5, resolution: "1080p" }, status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${id}`, totalTokens: null, costUsd: null,
  creditsBilled: 43, refineCostUsd: null, refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, failure: null, createdBy: "someone",
  authorName: "Tester", shotId, shotCode: null, shotScene: null, shotTitle: null, version: 1, durationMs: 20_000, durationS: 5, provider: "ark", attempts: 1,
  task: "generate", sourceGenId: null, createdAt: Date.now() - 600_000, updatedAt: Date.now() - 600_000, ...over,
});

/** The draft names its generations (a saved draft is refused when one is missing), so the looks' stills are real rows in this workspace's database. */
async function stills(workspaceId: string, ids: string[]) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].db_url);
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    const now = Date.now();
    for (const id of ids)
      await tenant.execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,created_by,created_at,updated_at,settled_at,stored_url,cost_usd) VALUES(?,'image','gemini-3-pro-image',?,'{}','succeeded','tester',?,?,?,?,0)",
        args: [id, "A look", now, now, now, `/api/media/${id}`] });
  } finally { tenant.close(); platform.close(); }
}

async function seed(page: Page, opts: { looks?: boolean; takes?: boolean }) {
  const workspaceId = (await signInLocally(page.request, "Looks Tester")).workspace.id;
  const tag = Date.now().toString(36);
  const ids = [1, 2, 3, 4].map((n) => `glk${tag}${n}`);
  if (opts.looks) await stills(workspaceId, ids);
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const project: Project = {
    ...newProject("Pier film"), id: `looks-${Date.now().toString(36)}`, aspect: "16:9", fps: 24, brief: "A figure on a pier at dawn.", direction: "Soft mist.",
    nodes: [shotNode("node-shot0001", "Opening", "shot-a1"), shotNode("node-shot0002", "The turn", "shot-a2")],
    production: {
      beats: beats(),
      ...(opts.looks ? { boards: { style: "live" as const, model: "gemini-3.1-flash-image" as const, frames: {}, looks: {
        "golden-hour": look("Golden hour", ids[0]), "blue-hour": look("Blue hour", ids[1]),
        "bleach-bypass": look("Bleach bypass", ids[2]), "clean-daylight": look("Clean daylight", ids[3]),
      } } } : {}),
    },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await page.request.post("/api/workbench/projects", { headers, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const generations: Gen[] = opts.takes ? shotIds.map((s, i) => take(`tk-s${i + 1}`, s)) : [];
  const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/workbench/library?**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return json(route, new URL(route.request().url()).searchParams.get("source") === "generations" ? { generations, nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
  await page.route(/\/api\/media\/(tk-|glk)/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || /\/release$/.test(path) || path.startsWith("/api/workbench/atomik"))) paid.push(path);
  });
  return { project, scope, headers, paid };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const glide = async (page: Page, rail: string) => { await page.getByTestId("board-rail").getByText(rail, { exact: true }).click(); await page.waitForTimeout(600); };

test("four looks, a tick to pick one (free); the pick names the group, saves itself and survives a reload", async ({ page }, info) => {
  const { project, scope, headers, paid } = await seed(page, { looks: true });
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  if (!desktop(page)) {
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(paid).toEqual([]);
    return;
  }
  const group = page.locator('[data-card-id="group:looks"]');
  await expect(group).toContainText("Looks");
  await expect(group).toContainText("pick one, or tell Atomik what to change");
  const tiles = page.locator('[data-card-kind="look"]');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(0)).toContainText("Golden hour");
  await expect(tiles.nth(0)).toContainText("Nano Banana Pro · 1K");
  await expect(tiles.nth(1).getByRole("button")).toHaveAttribute("aria-pressed", "false");
  await glide(page, "Looks");
  await page.screenshot({ path: `${SHOTS}/looks-${info.project.name.replace("workbench-", "")}.png` });

  await tiles.nth(1).getByRole("button", { name: "Pick Blue hour" }).click();
  await expect(page.getByTestId("toast")).toContainText("Blue hour picked");
  await expect(group).toContainText("Blue hour picked");
  await expect(tiles.nth(1).getByRole("button")).toHaveAttribute("aria-pressed", "true");
  await expect(tiles.nth(0).getByRole("button")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => {
    const read = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers });
    return ((await read.json()) as { project: Project | null }).project?.production?.boards?.look ?? "";
  }, { timeout: 15_000 }).toBe("blue-hour");
  void scope;
  await page.reload();
  await expect(page.locator('[data-card-id="group:looks"]')).toContainText("Blue hour picked");

  /* The Inspector says what the look was made from (the nearest frame to § 3.1 k). */
  await page.locator('[data-card-kind="look"]').nth(2).click({ position: { x: 20, y: 120 } });
  await expect(page.getByTestId("insp-look")).toContainText("Bleach bypass");
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-card-kind="look"] *')]
    .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
  expect(small).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(paid).toEqual([]);
});

test("Where to next? appears once every shot is approved: three cards that open Make or Crew, sending nothing", async ({ page }, info) => {
  const withTakes = await seed(page, { takes: true });
  await page.goto(`/suites?project=${withTakes.project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  if (!desktop(page)) {
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(withTakes.paid).toEqual([]);
    return;
  }
  const group = page.locator('[data-card-id="group:next"]');
  await expect(group).toContainText("Where to next?");
  const cards = page.locator('[data-card-kind="next"]');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("9:16 cutdown");
  await expect(cards.nth(1)).toContainText("Campaign stills");
  await expect(cards.nth(2)).toContainText("Crew review of the cut");
  /* The stills card carries the server's price for one still, read, never sent. */
  await expect(cards.nth(1).getByTestId("board-next-stills")).toContainText(/\d[\d.,]* cr each/, { timeout: 20_000 });
  /* Pan the canvas up to the group, clear of the tool pill. */
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 260);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/where-to-next-${info.project.name.replace("workbench-", "")}.png` });

  await cards.nth(1).getByTestId("board-next-stills").click();
  await expect(page).toHaveURL(/make=image/);
  expect(withTakes.paid).toEqual([]);
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-card-kind="next"] *')]
    .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
  expect(small).toEqual([]);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test("with a shot still waiting, Where to next? is not there", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seed(page, { takes: false });
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  await expect(page.locator('[data-card-id="group:storyboard"]')).toBeVisible();
  await expect(page.locator('[data-card-kind="next"]')).toHaveCount(0);
  expect(paid).toEqual([]);
  mkdirSync(SHOTS, { recursive: true });
});
