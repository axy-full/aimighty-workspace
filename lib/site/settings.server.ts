import { platformDb, platformReady, now } from "@/lib/platform";
import { DEFAULT_SITE, SITE_ROW, cleanSite, type SiteSettings } from "./settings";

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
export async function writeSite(patch: Partial<SiteSettings>, by: string | null): Promise<SiteSettings> {
  await platformReady();
  if (patch.guestWorkspace) {
    const rs = await platformDb().execute({ sql: `SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL LIMIT 1`, args: [patch.guestWorkspace] });
    if (!rs.rows.length) throw new SiteSettingsError("That workspace is not on this deployment.");
  }
  const next = cleanSite({ ...(await readSite()), ...patch });
  await platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [SITE_ROW, JSON.stringify(next), now(), by],
  });
  return next;
}
