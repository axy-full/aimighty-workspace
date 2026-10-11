import { platformDb, platformReady, now } from "@/lib/platform";
import { DEFAULT_SITE, SITE_ROW, cleanSite, newInterfaceOffKey, type SitePatch, type SiteSettings } from "./settings";

/**
 * The server half of the site switches (lib/site/settings.ts). One primary-key read of the platform layer's own
 * key/value table, no cache, so a change in /admin shows on the next request. The platform layer's reader ignores
 * keys it does not know, so plans, caps and defaults are untouched by this row.
 */
export async function readSite(): Promise<SiteSettings> {
  try {
    await platformReady();
    const rs = await platformDb().execute({ sql: `SELECT value FROM platform_layer WHERE key = ?`, args: [SITE_ROW] });
    const raw = (rs.rows[0] as { value?: unknown } | undefined)?.value;
    if (typeof raw !== "string") return { ...DEFAULT_SITE };
    return cleanSite(JSON.parse(raw));
  } catch {
    /* Fail closed: an unreadable row is every switch off. */
    return { ...DEFAULT_SITE };
  }
}

export class SiteSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Applies a checked change (lib/site/settings.ts › sitePatch) on top of the stored row. A guest workspace must be a
 * live workspace on this deployment. `by` is the platform owner's account id.
 */
export async function writeSite(patch: SitePatch, by: string | null): Promise<SiteSettings> {
  await platformReady();
  if (patch.guestWorkspace) {
    const rs = await platformDb().execute({ sql: `SELECT id, legacy FROM workspaces WHERE id = ? AND deleted_at IS NULL LIMIT 1`, args: [patch.guestWorkspace] });
    if (!rs.rows.length) throw new SiteSettingsError("That workspace is not on this deployment.");
    /* Guests read a separate public-sample workspace ("Particl sample", lead decision 41), never the house workspace. */
    if (Number((rs.rows[0] as { legacy?: unknown }).legacy) === 1) throw new SiteSettingsError("Guests can't read the house workspace. Name the public sample workspace.");
  }
  if (patch.newInterfaceOffAdd) {
    const rs = await platformDb().execute({ sql: `SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL LIMIT 1`, args: [patch.newInterfaceOffAdd] });
    if (!rs.rows.length) throw new SiteSettingsError("That workspace is not on this deployment.");
    await platformDb().execute({
      sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [newInterfaceOffKey(patch.newInterfaceOffAdd), "1", now(), by],
    });
  }
  if (patch.newInterfaceOffRemove) await platformDb().execute({ sql: `DELETE FROM platform_layer WHERE key = ?`, args: [newInterfaceOffKey(patch.newInterfaceOffRemove)] });
  const { newInterfaceOffAdd: _add, newInterfaceOffRemove: _remove, ...own } = patch;
  void _add; void _remove;
  const next = cleanSite({ ...(await readSite()), ...own });
  await platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [SITE_ROW, JSON.stringify(next), now(), by],
  });
  return next;
}

/** The workspaces kept on today's screens, as the owner's Site block lists them: one row each, so there is no cap. */
export async function listNewInterfaceOff(): Promise<string[]> {
  try {
    await platformReady();
    const rs = await platformDb().execute({ sql: `SELECT key FROM platform_layer WHERE key GLOB 'ni_off:*' ORDER BY updated_at DESC`, args: [] });
    return rs.rows.map((r) => String((r as { key?: unknown }).key).slice("ni_off:".length));
  } catch { return []; }
}

/** Whether one workspace is kept on today's screens: a primary-key read of its own row. */
export async function workspaceNewInterfaceOff(workspaceId: string): Promise<boolean> {
  try {
    await platformReady();
    const rs = await platformDb().execute({ sql: `SELECT 1 AS one FROM platform_layer WHERE key = ?`, args: [newInterfaceOffKey(workspaceId)] });
    return rs.rows.length > 0;
  } catch { return false; }
}
