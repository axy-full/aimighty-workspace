import { expect, type Page } from "@playwright/test";
import { gunzipSync } from "node:zlib";
import sharp from "sharp";
import { signInLocally } from "./workbenchLocal";
import { forbidPaidWork, mockLibrary, mockMedia, upload } from "./workspaceFixtures";
import { smallTargets, smallText } from "../phoneFloors";
import { newProject, type Asset, type Project } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";

/**
 * Fixtures for Business › Particl's own tools (tests/suites-business-own*.spec.ts):
 * a project store that checks every save against the real schema, the page
 * opened on a real local sign-in, and the floors every page keeps.
 */
export const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
export const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
export const png = (background = "#2b4f6e", width = 640, height = 480) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

export const still = (id: string, fields: Partial<Asset> = {}): Asset => ({ id, uploadId: id, url: `/api/uploads/${id}`, kind: "image", category: "Product", name: `${id}.webp`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...fields });
export const fixture = (fields: Partial<Project> = {}): Project => ({ ...newProject("Northline launch"), id: "ws-northline", productionProjectId: "prod-northline", shotMappings: {}, ...fields });

export type Store = { project: Project; revision: number; saves: number; refused: string[] };
/** The project store as the route keeps it: every save checked against the real schema, revision by revision. */
export async function projectStore(page: Page, start: Project): Promise<Store> {
  const store: Store = { project: start, revision: 1, saves: 0, refused: [] };
  await page.route("**/api/workbench/projects**", async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { projects: [{ id: store.project.id, name: store.project.name, revision: store.revision, updatedAt: "2026-09-28T10:00:00Z" }], productions: [], project: store.project, revision: store.revision, shared: null } });
    if (request.method() === "PUT") {
      const raw = request.postDataBuffer() ?? Buffer.from("{}");
      const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString() : raw.toString();
      const parsed = saveSchema.safeParse(JSON.parse(text));
      if (!parsed.success) { store.refused.push(parsed.error.issues.map((i) => i.message).join("; ")); return route.fulfill({ status: 400, json: { error: "The project could not be saved." } }); }
      if (parsed.data.revision !== store.revision) return route.fulfill({ status: 409, json: { error: "This project changed in another window." } });
      store.revision++;
      store.saves++;
      store.project = { ...(parsed.data.project as Project), productionProjectId: start.productionProjectId, shotMappings: {} };
      return route.fulfill({ json: { revision: store.revision, productionProjectId: start.productionProjectId, shotMappings: {} } });
    }
    return route.fulfill({ status: 400, json: { error: "Unexpected projects request in a Business test." } });
  });
  return store;
}

export type Seen = { errors: string[]; account: string[]; paid: string[]; reads: Record<string, unknown>[]; store: Store };
/**
 * Business at `sp`, on `start`, signed in locally (an owner, unless the page is already a member's). Records page
 * errors, any POST to a connected-account route, and every paid POST (a render or an agent run).
 */
export async function openBusiness(page: Page, sp: string, start: Project, options: { member?: boolean; routes?: () => Promise<unknown> } = {}): Promise<Seen> {
  if (!options.member) await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const store = await projectStore(page, start);
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: [] });
  await options.routes?.();
  const seen: Seen = { errors: [], account: [], paid: [], reads: [], store };
  page.on("pageerror", (error) => seen.errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/higgsfield/consumer/") && request.method() === "POST") seen.account.push(`${request.method()} ${path}`);
    if (request.method() === "POST" && /^\/api\/(generate|workbench\/atomik)$/.test(path)) {
      let body: { quoteOnly?: boolean } | null = null;
      try { body = request.postDataJSON() as { quoteOnly?: boolean } | null; } catch { /* not JSON: counted as paid */ }
      if (!body?.quoteOnly) seen.paid.push(path);
    }
  });
  await page.goto(`/suites?suite=moleculr&page=marketing&sp=${sp}&project=${start.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(start.name);
  return seen;
}

/**
 * The functional labels in `scope` dimmer than #7C7C84 as they land on screen: the colour's alpha and any opacity
 * composited over the ground above it. The measure of tests/phoneFloors.ts › dimLabels, one step stricter, as in
 * tests/suites-next-actions-workbench.spec.ts: a layer painted by a gradient, an image or a translucent fill counts as black
 * beneath it, the darkest ground there is, so the estimate is never brighter than the screen (the translucent cards
 * these pages sit on are gradients).
 */
export async function labelsUnderFloor(page: Page, scope: string): Promise<string[]> {
  return page.evaluate(async (scope) => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => null)));
    const labels = Array.from(document.querySelectorAll<HTMLElement>(scope)).flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("[data-functional-label]")));
    if (!labels.length) return [`no functional label in ${scope}`];
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (color: string): Rgba | null => {
      const srgb = color.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)$/);
      if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] == null ? 1 : Number(srgb[4]) };
      const rgb = color.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
      if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] == null ? 1 : Number(rgb[4]) };
      return color === "transparent" ? { r: 0, g: 0, b: 0, a: 0 } : null;
    };
    const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const luminance = (c: Rgba) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const ground = (el: HTMLElement): Rgba => {
      const layers: Rgba[] = [];
      for (let up = el.parentElement; up; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (style.backgroundImage !== "none") break;
        const bg = parse(style.backgroundColor);
        if (bg && bg.a > 0) layers.push(bg);
        if (bg && bg.a >= 1) break;
      }
      return layers.reverse().reduce((under, layer) => over(layer, under), { r: 0, g: 0, b: 0, a: 1 });
    };
    const opacity = (el: HTMLElement) => { let o = 1; for (let up: HTMLElement | null = el; up; up = up.parentElement) o *= Number(getComputedStyle(up).opacity); return o; };
    const floor = 0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5;
    const out: string[] = [];
    for (const el of labels) {
      if (!el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      if (!/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor)) continue;
      const ink = parse(style.color);
      if (!ink) { out.push(`${el.className || el.tagName}: unreadable colour ${style.color}`); continue; }
      const seen = over({ ...ink, a: ink.a * opacity(el) }, ground(el));
      if (luminance(seen) < floor) out.push(`${el.className || el.tagName}: ${style.color} (reads ${[seen.r, seen.g, seen.b].map(Math.round).join(", ")}) — “${(el.textContent ?? "").trim().slice(0, 24)}”`);
    }
    return out;
  }, scope);
}

/**
 * The floors at every size: nothing scrolls sideways, labels read at #7C7C84; on a phone every target in the tool is
 * 44px, no text is under 12px, and at the end of the page `last` sits above the floating tab bar.
 */
export async function expectBusinessFloors(page: Page, project: string, tool: string, last: string) {
  const root = `[data-testid="${tool}"]`;
  await page.locator(root).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => null))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal scroll").toBe(true);
  expect(await page.locator(root).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${tool} fits its width`).toBe(true);
  expect(await labelsUnderFloor(page, root), `${tool}: labels under #7C7C84`).toEqual([]);
  if (!PHONES.includes(project)) return;
  expect(await smallTargets(page, root), `${tool}: targets under 44×44`).toEqual([]);
  expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  const lastRow = page.getByTestId(last);
  await lastRow.scrollIntoViewIfNeeded();
  await page.getByTestId("content").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const bar = await page.locator(".gx-tabbar").boundingBox();
  const row = await lastRow.boundingBox();
  if (bar && row) expect(row.y + row.height, "the last row clears the tab bar").toBeLessThanOrEqual(bar.y + 1);
}
