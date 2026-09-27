import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { requireTenant } from "@/lib/tenant";
import { seedStarterProduction, starterProductionId } from "@/lib/starter";
import type { CastEntry } from "@/lib/production/cast";
import { readDraft, saveDraft, workbenchReady, workbenchTransaction } from "./records";
import { newProject, type Asset, type CanvasNode, type Project, type Shot } from "./studio";

/**
 * "Explore the starter production" (Studio's first run): the workspace's
 * starter production (lib/starter.ts), seeded the first time anyone asks,
 * opened as this person's own Studio draft.
 *
 * Idempotent at both levels. The workspace gets one starter production,
 * because the seed checks and writes in one transaction. Each person gets one
 * draft of it, because the draft's id is derived from the workspace, the
 * person and the production, and revision 0 only ever inserts. A second press
 * (a double click, a retried request) opens what the first one made.
 */
export type StarterSource = {
  production: { id: string; name: string; description: string };
  shots: { id: string; code: string; title: string; description: string; planned: number | null }[];
  cast: { name: string; kind: string; description: string }[];
  takes: { id: string; shotId: string | null; version: number; prompt: string; approved: boolean; createdAt: number }[];
};

/** One draft per workspace, person and starter production. */
export function starterDraftId(workspaceId: string, owner: string, productionId: string): string {
  return "starter-" + createHash("sha256").update(JSON.stringify([workspaceId, owner, productionId])).digest("hex").slice(0, 24);
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * The seeded production as a Studio draft. It is pure and adds nothing the
 * production does not hold:
 * - each shot becomes a Rig shot (`shotOf` maps it back to the production's
 *   shot, so a render files its take under the same shot);
 * - each shot's approved take, else its newest, is the picture on its node;
 * - the cut lists the shots in order, and holds a clip only where a take is approved;
 * - the cast becomes Cast & Elements entries;
 * - the brief is the shots' descriptions.
 * The takes themselves come from the production's library, not the draft.
 */
export function starterDraft(draftId: string, source: StarterSource, createdAt: string): { project: Project; shotOf: Record<string, string> } {
  const base = newProject(source.production.name.trim().slice(0, 100) || "Starter production");
  const assets: Asset[] = [];
  const nodes: CanvasNode[] = [];
  const cut: Shot[] = [];
  const shotOf: Record<string, string> = {};
  source.shots.forEach((shot, i) => {
    const own = source.takes.filter((t) => t.shotId === shot.id).sort((a, b) => a.version - b.version || a.createdAt - b.createdAt);
    const approved = own.find((t) => t.approved) ?? null;
    const shown = approved ?? own.at(-1) ?? null;
    const title = (shot.title.trim() || shot.code).slice(0, 300);
    const picture: Asset | null = shown ? {
      id: `take-${shown.id}`, name: `${shot.code} · v${shown.version}`, kind: "video", category: "Shot",
      url: `/api/media/${encodeURIComponent(shown.id)}`, description: title, prompt: shown.prompt.slice(0, 20000),
      status: approved ? "Selected" : "Draft", locked: false, version: Math.max(1, shown.version), refs: [],
      generationId: shown.id, productionShotId: shot.id,
    } : null;
    if (picture) assets.push(picture);
    const nodeId = `node-shot-${two(i + 1)}`;
    shotOf[nodeId] = shot.id;
    const seconds = shot.planned && shot.planned > 0 ? Math.min(60, Math.round(shot.planned)) : null;
    nodes.push({
      id: nodeId, title, type: "scene", text: shot.description.slice(0, 30000), x: 40 + i * 400, y: 80, width: 344, linked: [],
      ...(seconds ? { durationS: seconds } : {}), ...(picture ? { assetId: picture.id } : {}), ...(approved ? { status: "approved" as const } : {}),
    });
    cut.push({
      id: `cut-${two(i + 1)}`, name: `${shot.code} — ${title}`.slice(0, 300), assetId: approved && picture ? picture.id : "",
      duration: Math.max(1, (seconds ?? 5) * base.fps), sourceIn: 0, note: shot.description.slice(0, 10000),
    });
  });
  const entries: CastEntry[] = source.cast.slice(0, 100).map((c, i) => ({
    id: `cast-${two(i + 1)}`, name: c.name.slice(0, 120), kind: c.kind === "character" ? "character" : "element",
    description: c.description.slice(0, 2000), prompt: c.description.slice(0, 5000), takes: [],
    category: c.kind === "character" ? "character" : c.kind === "location" ? "environment" : "prop",
  }));
  const project: Project = {
    ...base,
    id: draftId,
    description: source.production.description.slice(0, 500),
    brief: source.shots.map((s) => s.description.trim()).filter(Boolean).join(" ").slice(0, 30000),
    productionProjectId: source.production.id,
    assets, nodes, shots: cut, createdAt,
    ...(entries.length ? { production: { cast: { entries } } } : {}),
  };
  return { project, shotOf };
}

/** What the starter production holds now: a teammate may have renamed it, filed takes or hidden some. */
export async function readStarterSource(productionId: string): Promise<StarterSource | null> {
  const [row, shots, cast, takes] = await Promise.all([
    db().execute({ sql: `SELECT id, name, description FROM projects WHERE id = ? AND starter = 1`, args: [productionId] }),
    db().execute({ sql: `SELECT id, code, title, description, planned FROM shots WHERE project_id = ? ORDER BY position, created_at, id`, args: [productionId] }),
    db().execute({ sql: `SELECT name, kind, description FROM cast_members WHERE project_id = ? ORDER BY created_at, id`, args: [productionId] }),
    db().execute({ sql: `SELECT id, shot_id, version, prompt, review_state, created_at FROM generations WHERE project_id = ? AND deleted = 0 AND status = 'succeeded' ORDER BY created_at, id`, args: [productionId] }),
  ]);
  const p = row.rows[0];
  if (!p) return null;
  return {
    production: { id: String(p.id), name: String(p.name ?? ""), description: String(p.description ?? "") },
    shots: shots.rows.map((r) => ({ id: String(r.id), code: String(r.code ?? ""), title: String(r.title ?? ""), description: String(r.description ?? ""), planned: r.planned == null ? null : Number(r.planned) })),
    cast: cast.rows.map((r) => ({ name: String(r.name ?? ""), kind: String(r.kind ?? "character"), description: String(r.description ?? "") })),
    takes: takes.rows.map((r) => ({ id: String(r.id), shotId: r.shot_id == null ? null : String(r.shot_id), version: Number(r.version ?? 1), prompt: String(r.prompt ?? ""), approved: r.review_state === "approved", createdAt: Number(r.created_at ?? 0) })),
  };
}

export class StarterUnavailableError extends Error {
  constructor(message = "The starter production could not be opened. Try again.") { super(message); this.name = "StarterUnavailableError"; }
}

/**
 * Seed the workspace's starter production if it has none, and open this
 * person's draft of it: the one they already have, else a new one.
 * `created` says whether this call made the draft, and `seeded` whether it
 * made the production.
 */
export async function openStarterDraft(owner: string): Promise<{ project: Project; revision: number; created: boolean; seeded: boolean }> {
  await workbenchReady();
  const made = await seedStarterProduction(owner);
  const seeded = Boolean(made);
  const productionId = made?.projectId ?? (await starterProductionId());
  if (!productionId) throw new StarterUnavailableError();
  const draftId = starterDraftId(requireTenant().id, owner, productionId);
  const existing = await readDraft(owner, draftId);
  if (existing) return { ...existing, created: false, seeded };
  const source = await readStarterSource(productionId);
  if (!source) throw new StarterUnavailableError();
  const { project, shotOf } = starterDraft(draftId, source, new Date().toISOString());
  /* Each Rig shot is the production's own shot, mapped before the draft's first save so the save carries the mapping. */
  await workbenchTransaction(async (tx) => {
    for (const [nodeId, shotId] of Object.entries(shotOf))
      await tx.execute({
        sql: `INSERT INTO workbench_shots(owner,draft_id,node_id,project_id,shot_id) VALUES (?,?,?,?,?) ON CONFLICT(owner,draft_id,node_id) DO NOTHING`,
        args: [owner, draftId, nodeId, productionId, shotId],
      });
  });
  try {
    const saved = await saveDraft(owner, project, 0);
    return { project: { ...project, productionProjectId: saved.productionProjectId, shotMappings: saved.shotMappings }, revision: saved.revision, created: true, seeded };
  } catch (error) {
    /* Another press of the same person saved it first: open that copy rather than fail or make a second. */
    const again = await readDraft(owner, draftId);
    if (again) return { ...again, created: false, seeded };
    throw error;
  }
}
