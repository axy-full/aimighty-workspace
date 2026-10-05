import { expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./newInterface";
import { EMPTY_MOLECULR, type MoleculrBrief } from "../../lib/workbench/moleculr";
import { EMPTY_BRAND_KIT } from "../../lib/workbench/moleculr-creative";
import { newProject } from "../../lib/workbench/studio";
import { grey } from "./s03-board";

/* Stream 11's browser specs share this: a signed-in local workspace with the new interface on, and a project whose draft holds (or lacks) a Business brief. Neutral names only; nothing paid is sent. */
export const SHOTS = process.env.S11_SHOTS || "/private/tmp/claude-s11-shots";
export const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
export { grey };

export const FILLED: Partial<MoleculrBrief> = {
  productName: "Glass bottle", productBrand: "Clear Co", productDescription: "Borosilicate glass, 750 ml.\nDishwasher safe.", productUrl: "https://shop.example.test/bottle",
  hooks: ["Water, simply.", "Ninety seconds of quiet.", "Made to be refilled."],
  brandKit: { ...EMPTY_BRAND_KIT, name: "Clear Co", tagline: "Water, simply.", voice: "Quiet, exact.", colors: ["#0A84FF", "#F5F5F7", "#FF9F0A", "#141414"], font: "system", source: { url: "https://clear.example.test/", reviewedAt: "2026-10-05T10:00:00.000Z" } },
};

export async function seedAds(page: Page, brief: Partial<MoleculrBrief> | null = FILLED, kind: "ads" | "social" = "ads") {
  const workspaceId = (await signInWithNewInterface(page.request, "Ads Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const base = newProject("Campaign fixture");
  const project = { ...base, boardKind: kind, ...(brief ? { moleculr: { ...EMPTY_MOLECULR, ...brief } } : {}) };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = await saved.json() as { productionProjectId?: string };
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || path.startsWith("/api/generate/") && !path.endsWith("/quote") || path === "/api/workbench/atomik" && request.postData()?.includes('"quoteOnly":true') === false)) paid.push(path);
  });
  return { project, paid, productionId: productionId ?? null, scope, headers: { "X-Workbench-Scope": scope } };
}

export const adsUrl = (id: string, extra = "") => `/suites?project=${id}&view=board&kind=ads${extra}`;
