import { newInterfaceOn, type NewInterfaceWorkspace } from "./newInterface";
import { readSite } from "./site/settings.server";

/** The switch for a session's workspace, read from the site settings; a settings row that can't be read means off. */
export async function newInterfaceFor(workspace: NewInterfaceWorkspace | null | undefined): Promise<boolean> {
  if (!workspace) return false;
  if (workspace.legacy === true) return true;
  const site = await readSite().catch(() => null);
  return newInterfaceOn(workspace, site?.newInterfaceWorkspaces ?? []);
}
