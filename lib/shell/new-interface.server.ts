import { platformDb, platformReady, now } from "@/lib/platform";
import { INTERFACE_ROW, cleanRollout, rolloutIncludes, withWorkspace, type InterfaceRollout } from "./new-interface-model";

/**
 * The server half of the new-interface switch (lib/shell/new-interface-model.ts). The row sits in the platform
 * database's existing `platform_layer` table, under its own key: the platform layer's own reader ignores keys it
 * does not know (lib/platform.ts › platformLayerState), so plans, caps and defaults are untouched. Read with one
 * primary-key lookup and no cache, so a flip shows on the next page load.
 */
export async function readRollout(): Promise<InterfaceRollout> {
  await platformReady();
  const rs = await platformDb().execute({ sql: `SELECT value FROM platform_layer WHERE key = ?`, args: [INTERFACE_ROW] });
  const raw = (rs.rows[0] as { value?: unknown } | undefined)?.value;
  if (typeof raw !== "string") return cleanRollout(null);
  try { return cleanRollout(JSON.parse(raw)); } catch { return cleanRollout(null); }
}

/** Stores the cleaned rollout (what is written can never hold junk). `by` is the platform owner's account id. */
export async function writeRollout(next: InterfaceRollout, by: string | null): Promise<InterfaceRollout> {
  await platformReady();
  const cleaned = cleanRollout(next);
  await platformDb().execute({
    sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    args: [INTERFACE_ROW, JSON.stringify(cleaned), now(), by],
  });
  return cleaned;
}

/** Turns the switch on or off for one workspace. Null when the id is not a workspace id, or the list is full. */
export async function setWorkspaceNewInterface(workspaceId: string, on: boolean, by: string | null): Promise<InterfaceRollout | null> {
  const next = withWorkspace(await readRollout(), workspaceId, on);
  return next ? writeRollout(next, by) : null;
}

/** Turns it on or off for every workspace. */
export async function setNewInterfaceEveryone(everyone: boolean, by: string | null): Promise<InterfaceRollout> {
  return writeRollout({ ...(await readRollout()), everyone }, by);
}

/**
 * Whether this workspace sees the new interface. Off by default; a failed read is off, never a guess that shows a
 * customer a screen that was not meant for them yet.
 */
export async function newInterfaceEnabled(workspaceId: string | null | undefined): Promise<boolean> {
  if (!workspaceId) return false;
  try { return rolloutIncludes(await readRollout(), workspaceId); } catch { return false; }
}
