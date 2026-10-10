import { expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { signInToRedesign } from "./newInterface";
import { signInLocally } from "./workbenchLocal";
import { forbidPaidWork, mockMedia } from "./workspaceFixtures";
import { seedBoard } from "./gaps-l2";
import { localPlatformDbUrl } from "./workbenchLocal";
import { filmBoard } from "./boardV12";
import type { CanvasNode, Project } from "../../lib/workbench/studio";

/**
 * A Film board whose Shots stage has eight shots in mixed states (redesign P2-b): three finished takes, two still
 * rendering, three with nothing yet. Saved through the real projects route; each shot is mapped to its production shot
 * by the route's own `map-shot`, and the takes are rows in the workspace's local database (nothing is generated or
 * spent). Neutral names only (CLAUDE.md rule 3).
 */
const SHOT_TITLES = ["Opening wide", "The walk", "The rope", "Leaving", "The gull", "The horizon", "The engine", "Open water"];
const node = (i: number, linked: string[] = []): CanvasNode => ({ id: `node-shot000${i + 1}`, title: SHOT_TITLES[i], type: "scene", x: 0, y: 0, width: 254, linked, text: SHOT_TITLES[i] } as CanvasNode);

/**
 * The Rig's board (redesign P5): the cast, a place and a prop each with a picture, wired into the shots they appear in
 * (`CanvasNode.linked`): Skipper in shots 1–4, Deckhand in 2, 4 and 7, The quay in 1, 2, 4 and 8, Brass bell in 3 and 5.
 */
export const RIG_WIRES: Record<number, string[]> = {
  1: ["node-cast0001", "node-place001"], 2: ["node-cast0001", "node-cast0002", "node-place001"], 3: ["node-cast0001", "node-prop0001"], 4: ["node-cast0001", "node-cast0002", "node-place001"],
  5: ["node-prop0001"], 7: ["node-cast0002"], 8: ["node-place001"],
};
const RIG_PICTURES: Record<string, { asset: string; name: string; generation: string; category: string }> = {
  "node-cast0001": { asset: "a-skipper", name: "Skipper", generation: "gframe1", category: "cast" },
  "node-cast0002": { asset: "a-deckhand", name: "Deckhand", generation: "gframe2", category: "cast" },
  "node-place001": { asset: "a-quay", name: "The quay", generation: "gframe3", category: "environment" },
  "node-prop0001": { asset: "a-bell", name: "Brass bell", generation: "gframe4", category: "element" },
};
const rigAssets = () => Object.values(RIG_PICTURES).map((p) => ({ id: p.asset, name: p.name, kind: "image", category: p.category, url: `/api/media/${p.generation}`, description: "", prompt: "", status: "Selected", locked: false, version: 1, refs: [], generationId: p.generation }));

/** One take: its shot (1-based, by place when absent), version, status, and how long ago it was asked for. */
export type ShotRow = { shot?: number; version?: number; id?: string; status: "succeeded" | "running"; ageS?: number };
/** Shots 1–3 finished; 4–5 rendering; 6–8 nothing yet. */
const DEFAULT_ROWS: (ShotRow | null)[] = [{ status: "succeeded" }, { status: "succeeded" }, { status: "succeeded" }, { status: "running" }, { status: "running" }, null, null, null];
export async function openRigBoard(page: Page, path = "/suites?view=board&stage=shots", opts: { on?: boolean; rows?: (ShotRow | null)[]; rig?: boolean } = {}) {
  const signed = opts.on === false ? await signInLocally(page.request, "Shots Tester") : await signInToRedesign(page.request, "Shots Tester");
  if (opts.on !== false) await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false, { timeout: 30_000 }).toBe(true);
  const film = filmBoard();
  const own = (n: CanvasNode): CanvasNode => (opts.rig && RIG_PICTURES[n.id] ? { ...n, assetId: RIG_PICTURES[n.id].asset } : n);
  const nodes = [...film.nodes.filter((n) => n.type !== "scene").map(own), ...SHOT_TITLES.map((_, i) => node(i, opts.rig ? RIG_WIRES[i + 1] ?? [] : []))];
  const { project, scope } = await seedBoard(page, signed.workspace.id, (base) => ({ ...base, name: film.name, brief: film.brief, production: film.production, nodes, ...(opts.rig ? { assets: rigAssets() as Project["assets"] } : {}), }),
    { generations: [1, 2, 3, 4, 5].map((i) => `gframe${i}`) });
  const headers = { "X-Workbench-Scope": scope, "Content-Type": "application/json" };
  const shotIds: string[] = [];
  for (const n of SHOT_TITLES.map((_, i) => node(i, opts.rig ? RIG_WIRES[i + 1] ?? [] : []))) {
    const mapped = await page.request.post("/api/workbench/projects", { headers, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(String(((await mapped.json()) as { shotId: string }).shotId));
  }
  const production = project.productionProjectId!;
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const url = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [signed.workspace.id] })).rows[0].db_url);
    const db = createClient({ url, timeout: 10_000 });
    try {
      for (const [i, row] of (opts.rows ?? DEFAULT_ROWS).entries()) {
        if (!row) continue;
        const n = row.shot ?? i + 1;
        const asked = Date.now() - (row.ageS ?? 120) * 1000;
        await db.execute({
          sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,review_by,reviewed_at,deleted,error)
                VALUES (?,?,?,'image','gemini-3.1-flash-image',?,?,?,?,0,?,?,?,?,'google','generate','',NULL,NULL,0,NULL)`,
          args: [row.id ?? `gshot${i + 1}`, production, shotIds[n - 1], SHOT_TITLES[n - 1], JSON.stringify({ ratio: "16:9", resolution: "1K" }), row.status, row.status === "succeeded" ? "/campaign/hero.webp" : null, me.id, asked + i * 1000, asked + i * 1000, row.version ?? 1],
        });
      }
    } finally { db.close(); }
  } finally { platform.close(); }
  await forbidPaidWork(page);
  await mockMedia(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { project, scope, errors };
}
