import { expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { signInToRedesign } from "./newInterface";
import { signInLocally } from "./workbenchLocal";
import { forbidPaidWork, mockMedia } from "./workspaceFixtures";
import { seedBoard } from "./gaps-l2";
import { localPlatformDbUrl } from "./workbenchLocal";
import { filmBoard } from "./boardV12";
import type { CanvasNode } from "../../lib/workbench/studio";

/**
 * A Film board whose Shots stage has eight shots in mixed states (redesign P2-b): three finished takes, two still
 * rendering, three with nothing yet. Saved through the real projects route; each shot is mapped to its production shot
 * by the route's own `map-shot`, and the takes are rows in the workspace's local database (nothing is generated or
 * spent). Neutral names only (CLAUDE.md rule 3).
 */
const SHOT_TITLES = ["Opening wide", "The walk", "The rope", "Leaving", "The gull", "The horizon", "The engine", "Open water"];
const node = (i: number): CanvasNode => ({ id: `node-shot000${i + 1}`, title: SHOT_TITLES[i], type: "scene", x: 0, y: 0, width: 254, linked: [], text: SHOT_TITLES[i] } as CanvasNode);

export async function openShotsBoard(page: Page, path = "/suites?view=board&stage=shots", opts: { on?: boolean } = {}) {
  const signed = opts.on === false ? await signInLocally(page.request, "Shots Tester") : await signInToRedesign(page.request, "Shots Tester");
  if (opts.on !== false) await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false, { timeout: 30_000 }).toBe(true);
  const film = filmBoard();
  const nodes = [...film.nodes.filter((n) => n.type !== "scene"), ...SHOT_TITLES.map((_, i) => node(i))];
  const { project, scope } = await seedBoard(page, signed.workspace.id, (base) => ({ ...base, name: film.name, brief: film.brief, production: film.production, nodes }),
    { generations: [1, 2, 3, 4, 5].map((i) => `gframe${i}`) });
  const headers = { "X-Workbench-Scope": scope, "Content-Type": "application/json" };
  const shotIds: string[] = [];
  for (const n of SHOT_TITLES.map((_, i) => node(i))) {
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
      const at = Date.now() - 120_000;
      /* Shots 1–3 finished; 4–5 rendering (a minute in); 6–8 nothing yet. */
      const rows: [number, string][] = [[0, "succeeded"], [1, "succeeded"], [2, "succeeded"], [3, "running"], [4, "running"]];
      for (const [i, status] of rows) {
        await db.execute({
          sql: `INSERT INTO generations (id,project_id,shot_id,kind,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,version,provider,task,review_state,review_by,reviewed_at,deleted,error)
                VALUES (?,?,?,'image','gemini-3.1-flash-image',?,?,?,?,0,?,?,?,1,'google','generate','',NULL,NULL,0,NULL)`,
          args: [`gshot${i + 1}`, production, shotIds[i], SHOT_TITLES[i], JSON.stringify({ ratio: "16:9" }), status, status === "succeeded" ? "/campaign/hero.webp" : null, me.id, at + i * 1000, at + i * 1000],
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
