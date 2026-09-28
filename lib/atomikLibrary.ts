import { db, ready } from "./db";
import { requireTenant } from "./tenant";
import { engineMock } from "./mock";
import { higgsfieldConfigured, higgsfieldCredentials } from "./higgsfield";
import { listMarketingPresets } from "./higgsfieldMarketing";
import { prepareGeneration } from "./generationAdmission";
import { workbenchReady } from "./workbench/records";
import { projectLibraryReady, resolveProjectLibrary } from "./workbench/project-library";
import { LIBRARY_LIMITS, libraryName, type LibraryItem, type PresetItem } from "./atomikKeySteps";
import type { AdmissionActor } from "./admissionTypes";

/**
 * What Atomik's planner may build library steps from (lib/atomikKeySteps.ts),
 * read on the server for one person in one workspace.
 *
 * The Library is this project's own media, with the same membership the
 * Studio's Library shows (lib/workbench/project-library.ts): uploads filed to
 * the production or used by its takes, the production's own finished takes,
 * and what this person's Studio project for it links. Everything is read from
 * the workspace's own database, so another workspace's media cannot appear,
 * and nothing outside the production is listed. Media made on a signed-in
 * account's own site is never listed, nor are the starter production's
 * sample takes: only what this workspace made or uploaded.
 */

/** A take this workspace made itself: never one filed from a signed-in account's own site, nor a starter sample. */
const OWN_TAKE = `g.id NOT GLOB 'gen_hfc_*' AND NOT (json_valid(g.params) AND (
  COALESCE(json_extract(g.params,'$.consumerCreditUnit'),'')='higgsfield_credits' OR
  COALESCE(json_extract(g.params,'$.task'),'')='connected-generation' OR
  COALESCE(json_extract(g.params,'$.demo'),0)<>0))`;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Row = any;

const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const jsonOf = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "string") return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/**
 * This person's newest Studio project for a production: the one its
 * transforms file under, as GET /api/workbench/projects?production= answers.
 */
export async function studioProjectFor(owner: string, productionId: string | null): Promise<string | null> {
  if (!owner || !productionId) return null;
  await workbenchReady();
  const row = (await db().execute({
    sql: `SELECT project_id FROM workbench_projects WHERE owner=?
            AND (CASE WHEN json_valid(body) THEN json_extract(body,'$.productionProjectId') END)=?
          ORDER BY updated_at DESC LIMIT 1`,
    args: [owner, productionId],
  })).rows[0] as Row | undefined;
  return row ? String(row.project_id) : null;
}

/**
 * The project's Library as the planner is shown it: newest first, at most
 * twelve clips and sixteen stills, each with a handle (`V1`, `S1`) that is
 * all the planner ever cites.
 */
export async function plannerLibrary(p: { owner: string; projectId: string | null; studioProjectId?: string | null }): Promise<LibraryItem[]> {
  if (!p.projectId) return [];
  await ready();
  await projectLibraryReady();
  let scope = { productionProjectId: p.projectId, uploadIds: [] as string[], generationIds: [] as string[] };
  if (p.studioProjectId) {
    try {
      const linked = await resolveProjectLibrary(p.owner, p.studioProjectId);
      if (linked.productionProjectId === p.projectId) scope = linked;
    } catch { /* the production's own media still counts */ }
  }
  const limit = LIBRARY_LIMITS.videos + LIBRARY_LIMITS.stills;
  const [uploads, takes] = await Promise.all([
    db().execute({
      sql: `SELECT id, filename, kind, width, height, duration_s, created_at FROM uploads
            WHERE kind IN ('image','video') AND (
              id IN (SELECT value FROM json_each(?))
              OR id IN (SELECT upload_id FROM project_library_uploads WHERE project_id=?)
              OR id IN (SELECT j.atom FROM generations g, json_tree(g.params) j
                        WHERE g.project_id=? AND g.deleted=0 AND j.key IN ('uploadId','sourceUploadId','coverUploadId')))
            ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: [JSON.stringify(scope.uploadIds), scope.productionProjectId, scope.productionProjectId, limit],
    }),
    db().execute({
      sql: `SELECT g.id, g.kind, g.title, g.prompt, g.params, g.duration_s, g.created_at FROM generations g
            WHERE g.deleted=0 AND g.status='succeeded' AND COALESCE(g.stored_url,'')<>'' AND g.kind IN ('image','video')
              AND (g.project_id=? OR g.id IN (SELECT value FROM json_each(?)))
              AND ${OWN_TAKE}
            ORDER BY g.created_at DESC, g.id DESC LIMIT ?`,
      args: [scope.productionProjectId, JSON.stringify(scope.generationIds), limit],
    }),
  ]);
  type Found = Omit<LibraryItem, "handle"> & { at: number };
  const found: Found[] = [
    ...uploads.rows.map((r: Row): Found => ({
      kind: r.kind === "video" ? "video" : "image", origin: "upload", id: String(r.id), name: libraryName(r.filename),
      seconds: positive(r.duration_s), width: positive(r.width), height: positive(r.height), at: Number(r.created_at ?? 0),
    })),
    ...takes.rows.map((r: Row): Found => {
      const params = jsonOf(r.params);
      const size = [params.resolution, params.ratio].filter((v) => typeof v === "string" && v).join(" ");
      return {
        kind: r.kind === "video" ? "video" : "image", origin: "generation", id: String(r.id),
        name: libraryName(r.title || String(r.prompt ?? "").slice(0, 80) || "Take"),
        seconds: r.kind === "video" ? positive(r.duration_s) ?? positive(params.duration) : null,
        width: null, height: null, size: size || null, at: Number(r.created_at ?? 0),
      };
    }),
  ].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const out: LibraryItem[] = [];
  let videos = 0, stills = 0;
  for (const { at: _at, ...item } of found) {
    void _at;
    if (item.kind === "video" ? videos >= LIBRARY_LIMITS.videos : stills >= LIBRARY_LIMITS.stills) continue;
    const handle = item.kind === "video" ? `V${++videos}` : `S${++stills}`;
    out.push({ handle, ...item });
  }
  return out;
}

/* A workspace whose key lists no presets is not asked again for ten minutes. */
const presetReads = new Map<string, number>();
const PRESET_RETRY_MS = 10 * 60_000;
/** Seen within the hour: the presets admission accepts (lib/higgsfieldMarketing.ts › requireMarketingPreset). */
const PRESET_FRESH_MS = 3_600_000;

async function freshPresets(fingerprint: string): Promise<Row[]> {
  try {
    const rows = await db().execute({
      sql: `SELECT id, name FROM higgsfield_marketing_presets WHERE credential_fingerprint=? AND seen_at>? ORDER BY LOWER(name), id LIMIT ?`,
      args: [fingerprint, Date.now() - PRESET_FRESH_MS, LIBRARY_LIMITS.presets],
    });
    return rows.rows as Row[];
  } catch {
    return []; // No catalogue read yet in this workspace: no table, no presets.
  }
}

/**
 * The Marketing Studio presets the planner may name: the ones this platform
 * key listed within the hour, which admission also accepts. Read from what is
 * kept, never from the provider, so a planning quote is never held up by it
 * and the quote and its turn read the same list.
 */
export async function plannerPresets(): Promise<PresetItem[]> {
  if (!higgsfieldConfigured()) return [];
  await ready();
  const rows = await freshPresets(higgsfieldCredentials().fingerprint);
  return rows.map((r, i) => ({ handle: `P${i + 1}`, id: String(r.id), name: libraryName(r.name) }));
}

/**
 * Whether the presets kept for this key have gone stale and are worth reading
 * again: none listed within the hour, and not asked in the last ten minutes
 * (a key that lists none is not asked on every look). Marks the attempt.
 */
export async function plannerPresetsStale(): Promise<boolean> {
  if (engineMock() || !higgsfieldConfigured()) return false;
  await ready();
  const { fingerprint } = higgsfieldCredentials();
  const key = `${requireTenant().id}:${fingerprint}`;
  if (Date.now() - (presetReads.get(key) ?? 0) <= PRESET_RETRY_MS) return false;
  if ((await freshPresets(fingerprint)).length) return false;
  presetReads.set(key, Date.now());
  return true;
}

/** Read the preset catalogue on the API key (free, non-generating), keeping what it lists for an hour. Never throws. */
export async function refreshPlannerPresets(): Promise<void> {
  try { await listMarketingPresets(); } catch { /* no presets on this plan: a still is still made from words and stills */ }
}

/**
 * Everything a planning turn (and its quote) reads for library steps, for
 * one person: their Studio project for the production, its Library and the
 * presets. Empty where this platform cannot run those engines.
 */
export async function plannerInputs(owner: string, projectId: string | null): Promise<{ library: LibraryItem[]; presets: PresetItem[]; studioProjectId: string | null }> {
  if (!higgsfieldConfigured()) return { library: [], presets: [], studioProjectId: null };
  try {
    const studioProjectId = await studioProjectFor(owner, projectId);
    const [library, presets] = await Promise.all([
      plannerLibrary({ owner, projectId, studioProjectId }),
      plannerPresets().catch(() => []),
    ]);
    return { library, presets, studioProjectId };
  } catch {
    return { library: [], presets: [], studioProjectId: null };
  }
}

/**
 * A library step's price before it is proposed: the admission quote for the
 * exact body its render sends (free; nothing is reserved or sent), as the
 * engine's dollars the step keeps like every other estimate. A refusal is
 * the admission's own reason: the source is too short, a still is gone, no
 * live estimate came back. Nothing is guessed.
 */
export async function priceKeyStep(body: Record<string, unknown>, actor: AdmissionActor): Promise<{ usd: number } | { error: string }> {
  try {
    const prepared = await prepareGeneration(body, actor);
    if (!prepared.ok) {
      const error = prepared.body.error;
      return { error: typeof error === "string" && error ? error : "This step could not be priced." };
    }
    const params = prepared.value.compiled.params as Record<string, unknown> | undefined;
    const usd = Number(params?.higgsfieldVendorCostUsd);
    return Number.isFinite(usd) && usd > 0 ? { usd } : { error: "This step could not be priced." };
  } catch {
    return { error: "This step could not be priced right now." };
  }
}
