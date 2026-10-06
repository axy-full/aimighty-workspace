import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import sharp from "sharp";
import { expect, type Page, type Route } from "@playwright/test";
import { localPlatformDbUrl } from "./workbenchLocal";
import { newProject, type Project } from "../../lib/workbench/studio";

/*
 * Gap screens, lane 2 (3D blocking, Transcribe, Line drawings, Cut-out): what the four browser specs share. A seeded project
 * written through the real route, the stills answered from the repo's own public files, a price answered where the spec needs
 * a figure, and a watcher that records every request a person's press could be spending on. Neutral names only.
 */

export const SHOTS = process.env.L2_SHOTS || "/private/tmp/claude-l2-shots";
export const FINGERPRINT = "c".repeat(64);
export const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
export const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;

/** A real upload through /api/uploads (a small still), so a project may name it; returns its id. */
export async function uploadStill(page: Page, workspaceId: string, name: string, color = "#3a5a7a"): Promise<string> {
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const headers = { "X-Workbench-Scope": `particl-active-${workspaceId}-${me.id}` };
  const buffer = await sharp({ create: { width: 640, height: 360, channels: 3, background: color } }).png().toBuffer();
  const made = await page.request.post("/api/uploads", { headers, multipart: { file: { name, mimeType: "image/png", buffer } } });
  expect(made.ok(), await made.text()).toBe(true);
  return ((await made.json()) as { id: string }).id;
}

/**
 * Write a project through /api/workbench/projects. With `generations`, the project is saved bare first, those take ids are filed
 * under its production in the workspace's own local database (rows only: nothing is generated), and the full project is saved after.
 */
export async function seedBoard(page: Page, workspaceId: string, build: (base: Project) => Project, options: { generations?: string[] } = {}) {
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const base = { ...newProject("A 15-second film"), aspect: "16:9", fps: 24, brief: "Lead crosses the desert; the sphere reflects her." };
  let revision = 0;
  if (options.generations?.length) {
    const first = await page.request.put("/api/workbench/projects", { headers, data: { project: base, revision } });
    expect(first.ok(), await first.text()).toBe(true);
    const saved = await first.json() as { revision: number; productionProjectId: string };
    revision = saved.revision;
    const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      const row = (await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0];
      const url = String(row.db_url);
      if (!url.startsWith("file:")) throw new Error("Browser fixtures require a local workspace database.");
      const db = createClient({ url, timeout: 10_000 });
      try {
        const at = Date.now() - 600_000;
        for (const [i, id] of options.generations.entries()) {
          await db.execute({
            sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,review_by,reviewed_at,deleted,error)
                  VALUES (?,?,NULL,'image','gemini-3.1-flash-image','A frame',?,'succeeded','/campaign/hero.webp',0,?,?,?,1,'google','generate','',NULL,NULL,0,NULL)`,
            args: [id, saved.productionProjectId, JSON.stringify({ ratio: "16:9" }), me.id, at + i * 1000, at + i * 1000],
          });
        }
      } finally { db.close(); }
    } finally { platform.close(); }
    base.productionProjectId = saved.productionProjectId;
  }
  const project = build(base);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  return { project, scope };
}

/** The repo's own stills stand in for every picture a spec shows (nothing is generated). */
export async function stills(page: Page, files: Record<string, string>) {
  for (const [pattern, file] of Object.entries(files)) {
    const body = readFileSync(join(process.cwd(), "public", file));
    await page.route(pattern, (route) => route.fulfill({ status: 200, contentType: "image/webp", body }));
  }
}

/** Every POST a press could spend on: the paid generation, the transcription (not its quote), a release. */
export function watchPaid(page: Page) {
  const paid: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/generate" || /\/release$/.test(path)) paid.push(path);
    if (path === "/api/audio/transcribe") { try { if (JSON.parse(request.postData() ?? "{}").quoteOnly !== true) paid.push(path); } catch { paid.push(path); } }
    if (path.startsWith("/api/soul/identities")) paid.push(path);
  });
  return paid;
}

/** The library reads the board makes, answered empty (free reads only). */
export async function emptyLibrary(page: Page) {
  await page.route("**/api/workbench/library?**", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const source = new URL(route.request().url()).searchParams.get("source");
    return json(route, source === "generations" ? { generations: [], nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
}

/**
 * Opens a project's board. The first visit after the dev server compiled a route can land on Home while the project list is still
 * being read; the project is there, so the address is asked for once more before the spec decides the board is missing.
 */
export async function gotoBoard(page: Page, projectId: string) {
  const url = `/suites?project=${projectId}&view=board`;
  await page.goto(url);
  const shown = await page.getByTestId("board").waitFor({ state: "visible", timeout: 25_000 }).then(() => true, () => false);
  if (!shown) await page.goto(url);
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
}
