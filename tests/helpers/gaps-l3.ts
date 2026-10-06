import { readFileSync, mkdirSync } from "node:fs";
import { expect, type Page, type Route } from "@playwright/test";
import { signInLocally } from "./workbenchLocal";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";

/*
 * Gap screens, lane 3 (Edit & Sound, Crew review, the empty Ads and Social boards, Social post states): what the browser specs
 * share. A fresh signed-in workspace, a seeded project whose cut holds two approved takes with a third waiting, the library
 * answered from the spec (no engine runs, nothing is generated), and a watcher on every request that could spend. Neutral names.
 */
export const SHOTS = process.env.L3_SHOTS || "/private/tmp/claude-l3-shots";
export const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
export const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
export const PNG = readFileSync("public/icon-192.png");

export async function shoot(page: Page, project: string, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/l3-${name}-${project.replace("workbench-", "")}.png`, animations: "disabled" });
}

/** A stereo 48 kHz 16-bit WAV of a 997 Hz tone at `dbfs` (peak), `seconds` long. */
export function wavTone(dbfs: number, seconds: number): Buffer {
  const rate = 48_000, n = Math.round(seconds * rate), amp = 10 ** (dbfs / 20);
  const buf = Buffer.alloc(44 + n * 4);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * 997 * i) / rate));
    buf.writeInt16LE(v, 44 + i * 4); buf.writeInt16LE(v, 46 + i * 4);
  }
  return buf;
}

const node = (id: string, title: string): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [] }) as CanvasNode;
export type Gen = Record<string, unknown> & { id: string };
export const take = (id: string, shotId: string, over: Record<string, unknown> = {}): Gen => ({
  id, projectId: null, projectName: null, arkTaskId: null, kind: "image", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
  approvedBy: null, approvedAt: null, model: "gemini-3-pro-image", prompt: `Frame for ${id}`, title: `Take ${id}`, params: { resolution: "1K" },
  status: "succeeded", sourceUrl: null, storedUrl: `/api/media/${id}`, totalTokens: null, costUsd: null, creditsBilled: 3, refineCostUsd: null,
  refineModel: null, refineInTokens: null, refineOutTokens: null, error: null, failure: null, createdBy: "someone", authorName: "Tester",
  shotId, shotCode: null, shotScene: null, shotTitle: null, version: 1, durationMs: 20_000, durationS: null, provider: "google", attempts: 1,
  task: "generate", sourceGenId: null, createdAt: Date.now() - 600_000, updatedAt: Date.now() - 600_000, ...over,
});
const clip = (id: string, genId: string, name: string): Asset => ({ id, name, kind: "image", category: "Take", url: `/api/media/${genId}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], generationId: genId, mime: "image/png" });

/** Every POST a press could spend on: a paid generation, a release, a sound request that is not a quote. */
export function watchPaid(page: Page) {
  const paid: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if ((path.startsWith("/api/generate") && path !== "/api/generate/quote") || /\/release$/.test(path)) paid.push(path);
    if (path.startsWith("/api/audio")) { try { if (JSON.parse(request.postData() ?? "{}").quoteOnly !== true) paid.push(path); } catch { paid.push(path); } }
  });
  return paid;
}

export type Seeded = { project: Project; scope: string; workspaceId: string; shotIds: string[]; generations: Gen[]; paid: string[] };

/**
 * Three shots on the board: the first two approved takes sit in the edit's sequence (5 s each), the third waits for review.
 * With `music`, a 5 s music clip (a real WAV served by the spec at `musicDbfs`) sits on the Music lane.
 */
export async function seedCut(page: Page, name: string, options: { music?: boolean; musicDbfs?: number; /** The second take of the cut waits for a person. */ pending?: boolean } = {}): Promise<Seeded> {
  const workspaceId = (await signInLocally(page.request, name)).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project: Project = {
    ...newProject("A 15-second film"), brief: "A short film about a morning market opening.",
    nodes: [node("node-shot0001", "Opening wide"), node("node-shot0002", "The first stall"), node("node-shot0003", "Close on hands")],
  };
  const assets: Asset[] = [clip("clip-a1", "tk-s1", "Opening wide"), clip("clip-a2", "tk-s2", "The first stall")];
  const sequence: Record<string, unknown> = {
    assets, shots: [
      { id: "cut-1", name: "Opening wide", assetId: "clip-a1", duration: 120, sourceIn: 0, note: "" },
      { id: "cut-2", name: "The first stall", assetId: "clip-a2", duration: 120, sourceIn: 24, note: "" },
    ],
  };
  if (options.music) {
    assets.push({ id: "aud-1", name: "Music sketch", kind: "audio", category: "Audio", url: "/api/media/aud-1", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], mime: "audio/wav" } as Asset);
    sequence.audioClips = [{ id: "mus-1", assetId: "aud-1", lane: "music", startFrame: 0, sourceIn: 0, duration: 120, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false }];
    const wav = wavTone(options.musicDbfs ?? -23, 6);
    await page.route(/\/api\/media\/aud-1/, (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: wav }));
  }
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  /* The server refuses a project that names a take it does not hold, and no engine runs here: the sequence is put into the draft as the browser reads it. */
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
    take("tk-s2", shotIds[1], options.pending ? {} : { reviewState: "approved", approvedBy: "Tester", approvedAt: Date.now() - 400_000 }),
    take("tk-s3", shotIds[2]),
  ];
  const paid = watchPaid(page);
  await page.route("**/api/workbench/library?**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source");
    if (route.request().method() !== "GET") return route.continue();
    return json(route, source === "generations" ? { generations, nextPageCursor: null } : { uploads: [], nextCursor: null });
  });
  await page.route(/\/api\/media\/tk-/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  return { project, scope, workspaceId, shotIds, generations, paid };
}

/** Console and page errors a screen raised, collected from the first call on. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon|ERR_|net::|\/api\/workbench\/projects/.test(m.text())) errors.push(m.text()); });
  return errors;
}
