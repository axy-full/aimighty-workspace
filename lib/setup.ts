import { db, ready } from "./db";
import { getSetting, setSetting } from "./settings";
import { CATEGORIES, type ShotSpec } from "./studio";

/**
 * Where a workspace's and a production's Setup live — on the server.
 *
 * Setup is four layers (brief 2.3): platform, workspace, production, shot.
 * Two of them were already server-side and two were not. The platform's is a
 * `platform_layer` row and the shot's is `shots.setup`; the middle two lived
 * in `localStorage` under `aw_setup_all` and `aw_setup_<projectId>`.
 *
 * That made a shared decision private to one browser. A producer who set a
 * production's Setup was the only person who had it: nobody else on the
 * production saw those defaults, the server never knew them, and clearing
 * site data threw them away. Worse, the workspace key was NOT keyed by
 * workspace, so switching workspaces carried one team's defaults into
 * another's composer.
 *
 * Both now sit in the tenant database, which is what scopes them: `db()`
 * hands out this workspace's database and nothing else's.
 */

/** Setup keys the platform actually offers. Anything else is not a Setup. */
const KEYS = new Set(CATEGORIES.map((c) => c.key));
const MAX_VALUE = 120;

/**
 * A Setup from the wire, reduced to what it is allowed to be.
 *
 * Unknown keys are dropped rather than rejected: the camera bank is platform
 * data and can lose a category between one deploy and the next, and a stored
 * Setup naming a category that no longer exists should degrade to the rest of
 * itself, not fail. `null` survives — brief 2.3 makes it an EXPLICIT CLEAR,
 * which is not the same as a key being absent (lib/setupLayers.ts).
 */
export function cleanSpec(input: unknown): ShotSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: ShotSpec = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!KEYS.has(k)) continue;
    if (v === null) { out[k] = null; continue; }
    if (typeof v !== "string") continue;
    out[k] = v.slice(0, MAX_VALUE);
  }
  return out;
}

function parse(raw: unknown): ShotSpec {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { return cleanSpec(JSON.parse(raw)); } catch { return {}; }
}

export async function workspaceSetup(): Promise<ShotSpec> {
  return parse(await getSetting("setup"));
}

export async function setWorkspaceSetup(spec: unknown, userId: string): Promise<ShotSpec> {
  const clean = cleanSpec(spec);
  await setSetting("setup", JSON.stringify(clean), userId);
  return clean;
}

export async function productionSetup(projectId: string): Promise<ShotSpec> {
  await ready();
  const rs = await db().execute({ sql: `SELECT setup FROM projects WHERE id = ?`, args: [projectId] });
  return rs.rows.length ? parse((rs.rows[0] as Record<string, unknown>).setup) : {};
}

/** Returns null when there is no such production HERE — the tenant scope. */
export async function setProductionSetup(projectId: string, spec: unknown): Promise<ShotSpec | null> {
  await ready();
  const clean = cleanSpec(spec);
  const rs = await db().execute({
    sql: `UPDATE projects SET setup = ? WHERE id = ?`,
    args: [JSON.stringify(clean), projectId],
  });
  return rs.rowsAffected ? clean : null;
}
