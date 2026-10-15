import { currentTenant } from "./tenant";
import { HOUSE_WORKSPACE_ID } from "./houseWorkspace";
import { platformDb, platformReady } from "./platform";

/**
 * The gate every new engine passes (the owner's standing rule, 15 Oct 2026: engines ON for the house workspace and for the workspaces
 * listed in a site setting, OFF for customers, each with its own kill switch):
 *
 *   engineEnabled(SWITCH)  =  the engine's own environment switch is exactly "1"   (the kill switch: unset or anything else is off for everyone)
 *                             AND ( the workspace is the house  OR  its id is in the site setting `enginesOnWorkspaces` ).
 *
 * The list is the `enginesOnWorkspaces` field of the site row (platform_layer, key `site`, lib/site/settings.server.ts): a list of
 * workspace ids, empty by default. This reader is tolerant of a row that does not carry it yet and fails closed on any read error.
 * With no workspace in scope the answer is off.
 */
const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** The engine's own switch, read when asked (never at import): on only for exactly "1". */
export const engineSwitchOn = (envName: string): boolean => process.env[envName] === "1";

/** The workspaces besides the house that the engines are on for, as the platform owner listed them. Fails closed. */
export async function enginesOnWorkspaces(): Promise<string[]> {
  try {
    await platformReady();
    const rs = await platformDb().execute({ sql: "SELECT value FROM platform_layer WHERE key = ?", args: ["site"] });
    const raw = (rs.rows[0] as { value?: unknown } | undefined)?.value;
    if (typeof raw !== "string") return [];
    const list = (JSON.parse(raw) as { enginesOnWorkspaces?: unknown }).enginesOnWorkspaces;
    return Array.isArray(list) ? [...new Set(list.filter((id): id is string => typeof id === "string" && WORKSPACE_ID.test(id)))].slice(0, 50) : [];
  } catch {
    return [];
  }
}

/** Is this engine on for this workspace (default: the one in scope)? */
export async function engineEnabled(envName: string, workspace: { id: string } | null | undefined = currentTenant()?.workspace): Promise<boolean> {
  if (!engineSwitchOn(envName) || !workspace) return false;
  if (workspace.id === HOUSE_WORKSPACE_ID) return true;
  return (await enginesOnWorkspaces()).includes(workspace.id);
}
