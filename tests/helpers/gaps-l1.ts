import { expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { newProject, type CanvasNode } from "../../lib/workbench/studio";
import { signInWithNewInterface } from "./newInterface";

/**
 * Gaps, lane 1 (Batch B): what its specs share. A signed-in local workspace with a production of three shots whose
 * takes are mocked in the browser (the library, the review trail, the notes), a record of every paid request that
 * was ever sent (there must be none), and the floors a person reads by: text no dimmer than 55% white on its real ground.
 */
const PNG = readFileSync("public/icon-192.png");
export const DESKTOP = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
export const PAID_PATHS = (path: string, method: string) => method === "POST" && (path === "/api/generate" || (path.startsWith("/api/generate/") && path !== "/api/generate/quote") || /\/release$/.test(path) || path === "/api/audio" || path === "/api/prompt/enhance");

export const node = (id: string, title: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [], ...extra });

export type Gen = Record<string, unknown> & { id: string };
export const take = (id: string, shotId: string, version: number, over: Record<string, unknown> = {}): Gen => ({
  id, projectId: null, projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
  approvedBy: null, approvedAt: null, model: "gemini-3-pro-image", prompt: `Frame for ${id}`, title: `Take ${id}`, params: { resolution: "1K" },
  status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${id}`, totalTokens: null, costUsd: null, creditsBilled: 3, refineCostUsd: null,
  refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, failure: null, createdBy: "someone", authorName: "Tester",
  shotId, shotCode: null, shotScene: null, shotTitle: null, version, durationMs: 20_000, durationS: null, provider: "google", attempts: 1,
  task: "generate", sourceGenId: null, createdAt: Date.now() - 600_000 + version * 1000, updatedAt: Date.now() - 600_000 + version * 1000, ...over,
});

export async function seedShots(page: Page, name = "Gaps Takes", credits = 2000) {
  const workspaceId = (await signInWithNewInterface(page.request, name)).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = {
    ...newProject("Takes fixture"),
    brief: "A short film about a morning market opening.",
    nodes: [node("node-shot0001", "Opening wide"), node("node-shot0002", "The first stall"), node("node-shot0003", "Close on hands")],
  };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const generations: Gen[] = [
    /* Shot 1 has one take that waits for a person. */
    take("tk-s1-v1", shotIds[0], 1),
    /* Shot 2: approved. Shot 3: not made yet. */
    take("tk-s2-v1", shotIds[1], 1, { reviewState: "approved", approvedBy: "Tester", approvedAt: Date.now() - 500_000 }),
  ];
  const reviews: { id: string; state: string }[] = [];
  const notes: { genId: string; text: string }[] = [];
  const paid: string[] = [];
  page.on("request", (request) => { if (PAID_PATHS(new URL(request.url()).pathname, request.method())) paid.push(new URL(request.url()).pathname); });
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/workbench/library?**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    if (route.request().method() !== "GET") return route.continue();
    return json(route, source === "generations" ? { generations, nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
  await page.route(/\/api\/media\/tk-/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  await page.route(/\/api\/jobs\/tk-[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    if (route.request().method() !== "PATCH") return route.continue();
    const body = route.request().postDataJSON() as { reviewState: string };
    reviews.push({ id, state: body.reviewState });
    const g = generations.find((x) => x.id === id);
    if (g) g.reviewState = body.reviewState;
    return json(route, { ok: true, review: { reviewState: body.reviewState, reviewBy: body.reviewState ? "Tester" : null, updatedAt: Date.now() } });
  });
  await page.route("**/api/notes**", (route) => {
    if (route.request().method() === "POST") {
      notes.push(route.request().postDataJSON() as { genId: string; text: string });
      return json(route, { ok: true, mentioned: [] });
    }
    const genId = new URL(route.request().url()).searchParams.get("genId");
    return json(route, { notes: notes.filter((n) => n.genId === genId).map((n, i) => ({ id: `n${i}`, text: n.text, author: "Tester", userId: me.id, createdAt: Date.now(), guest: false, mentions: [] })) });
  });
  void credits;
  return { project, scope, workspaceId, reviews, notes, paid, generations, shotIds };
}

/**
 * Every visible text in `scope` reads at 55% white or more where it really sits: its colour (alpha, and every opacity above it)
 * laid over the translucent grounds behind it, over black. Text on a picture is not measured (the picture is the ground).
 */
export async function textReadsAtFloor(page: Page, scope: string): Promise<string[]> {
  return page.evaluate(async (scope) => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)));
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (color: string): Rgba | null => {
      const srgb = color.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)$/);
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] == null ? 1 : Number(srgb[4]) };
      const rgb = color.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] == null ? 1 : Number(rgb[4]) };
      return color === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
    };
    const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = (c: Rgba) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const ground = (el: HTMLElement): Rgba => {
      const layers: Rgba[] = [];
      for (let up: HTMLElement | null = el; up; up = up.parentElement) {
        const bg = parse(getComputedStyle(up).backgroundColor);
        if (!bg || bg.a <= 0) continue;
        layers.push(bg);
        if (bg.a >= 1) break;
      }
      return layers.reverse().reduce((under, layer) => over(layer, under), { r: 0, g: 0, b: 0, a: 1 });
    };
    const opacity = (el: HTMLElement) => { let o = 1; for (let up: HTMLElement | null = el; up; up = up.parentElement) o *= Number(getComputedStyle(up).opacity); return o; };
    const floor = 0.55 * 255 - 1;
    const out: string[] = [];
    const roots = Array.from(document.querySelectorAll<HTMLElement>(scope));
    if (!roots.length) return [`no ${scope}`];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.textContent ?? "").trim();
        const el = n.parentElement;
        if (!text || !el || !el.getClientRects().length) continue;
        if (el.closest("video, img, [data-picture], .gx-lazy, .gx-take-media, .gx-mk-tile, .vr-ref-tile, .vr-src-media, .gx-badge")) continue;
        const ink = parse(getComputedStyle(el).color);
        if (!ink) { out.push(`unreadable colour on “${text.slice(0, 24)}”`); continue; }
        const seen = over({ ...ink, a: ink.a * opacity(el) }, ground(el));
        if (lum(seen) < floor) out.push(`${el.className || el.tagName}: reads ${[seen.r, seen.g, seen.b].map(Math.round).join(",")} — “${text.slice(0, 28)}”`);
      }
    }
    return out;
  }, scope);
}

/** The board pans on the wheel (half a step per tick): bring a card to near the top of the canvas so it is on the screen it is judged on. */
export async function bringIntoView(page: Page, locator: ReturnType<Page["locator"]>, top = 90) {
  const box = await locator.boundingBox();
  if (!box) return;
  await page.mouse.move(600, 400);
  await page.mouse.wheel(0, Math.round((box.y - top) * 2));
  await page.waitForTimeout(450);
}
