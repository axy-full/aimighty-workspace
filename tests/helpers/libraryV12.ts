import { expect, type Page } from "@playwright/test";
import { signInToRedesign } from "./newInterface";
import { signInLocally } from "./workbenchLocal";
import { forbidPaidWork, mockMedia, mockProjects } from "./workspaceFixtures";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";

/**
 * The Library tray in the new interface (components/v12/library/LibraryTray.tsx), on a board whose cards say what three
 * of its files are (a character, a location, a prop), with uploads and generations in its library. Neutral names only
 * (CLAUDE.md rule 3). GET /api/workbench/library answers as the route does, including its own `q` search over the names,
 * and every read is recorded so a spec can check the search went to the server.
 */
const T = Date.UTC(2026, 9, 9, 12);
const upload = (id: string, filename: string, w = 1600, h = 900) => ({ id, filename, mime: "image/webp", kind: "image", bytes: 1, width: w, height: h, durationS: null, sha256: "x", url: `/api/uploads/${id}`, createdAt: T });
const generation = (id: string, title: string, ratio = "16:9", kind = "image", status = "succeeded") => ({ id, kind, status, storedUrl: `/api/media/${id}`, sourceUrl: null, prompt: title, title, params: { ratio }, projectId: "ws-library", model: "gemini-3.1-flash-image", createdAt: T - 1000, costUsd: null, reviewState: null });

const UPLOADS = [
  upload("ulead", "Lead actor.webp", 1200, 1500),
  upload("uharbour", "Harbour at dusk.webp"),
  upload("ulogo", "Logo lockup.webp", 1500, 1000),
];
const GENERATIONS = [
  generation("glamp", "Brass lamp", "1:1"),
  generation("gopen", "Opening shot", "16:9"),
  generation("gvert", "Vertical cut", "9:16"),
  generation("gstill", "Morning light", "4:5"),
  /* Still rendering: the tray shows finished takes only. */
  generation("grender", "Night swim", "16:9", "image", "running"),
];

/* Older than the loaded pages: only a search or a lookup by id finds it. */
const ARCHIVE = upload("uarchive", "Archive frame.webp");

const node = (id: string, type: CanvasNode["type"], refKind: CanvasNode["refKind"], assetId: string, x: number): CanvasNode =>
  ({ id, title: id, type, refKind, assetId, x, y: 0, width: 240, linked: [] }) as CanvasNode;

export function libraryProject(): Project {
  const base = newProject("Launch film");
  return {
    ...base, id: "ws-library", productionProjectId: "prod-library", shotMappings: {},
    assets: [
      { id: "a-lead", name: "Lead actor", kind: "image", category: "cast", url: "/api/uploads/ulead", description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], uploadId: "ulead" },
      { id: "a-harbour", name: "Harbour at dusk", kind: "image", category: "environment", url: "/api/uploads/uharbour", description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], uploadId: "uharbour" },
      { id: "a-lamp", name: "Brass lamp", kind: "image", category: "element", url: "/api/media/glamp", description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], generationId: "glamp" },
    ] as Project["assets"],
    nodes: [node("cast-1", "character", "cast", "a-lead", 0), node("place-1", "element", "environment", "a-harbour", 300), node("prop-1", "element", "element", "a-lamp", 600)],
  };
}

/** `project`: the open board (default libraryProject()); `before`: more routes, set before the page opens. */
export async function openLibrary(page: Page, path = "/suites?view=board&drawer=Library", opts: { on?: boolean; project?: Project; before?: (page: Page) => Promise<void> } = {}) {
  if (opts.on === false) await signInLocally(page.request);
  else await signInToRedesign(page.request);
  if (opts.on !== false) await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false, { timeout: 30_000 }).toBe(true);
  await forbidPaidWork(page);
  await mockMedia(page);
  const project = opts.project ?? libraryProject();
  await mockProjects(page, { current: project, list: [{ id: project.id, name: project.name }, { id: "ws-other", name: "Spring campaign" }] });
  const reads: { projectId: string | null; source: string | null; q: string | null }[] = [];
  await page.route("**/api/workbench/library**", (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get("source");
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const projectId = url.searchParams.get("projectId");
    reads.push({ projectId, source, q: q || null });
    const mine = projectId === project.id;
    const match = (name: string) => !q || name.toLowerCase().includes(q);
    const id = url.searchParams.get("id");
    if (id && mine) {
      const all = source === "uploads" ? [...UPLOADS, ARCHIVE] : GENERATIONS;
      return route.fulfill({ json: source === "uploads" ? { uploads: all.filter((u) => u.id === id), nextCursor: null } : { generations: all.filter((g) => g.id === id), nextPageCursor: null } });
    }
    if (source === "uploads") return route.fulfill({ json: { uploads: mine ? [...UPLOADS, ...(q ? [ARCHIVE] : [])].filter((u) => match(u.filename)) : [upload("uother", "Spring poster.webp", 1000, 1250)], nextCursor: null } });
    return route.fulfill({ json: { generations: mine ? GENERATIONS.filter((g) => match(g.title)) : [], nextPageCursor: null } });
  });
  await opts.before?.(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { errors, reads, project };
}
