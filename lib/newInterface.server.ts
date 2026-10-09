import { isHouseWorkspace } from "./houseWorkspace";
import { newInterfaceOn } from "./newInterface";
import { readSite } from "./site/settings.server";

/** The switch for a session's workspace, read from the site settings; a settings row that can't be read means off. */
export async function newInterfaceFor(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!workspace) return false;
  if (isHouseWorkspace(workspace)) return true;
  const site = await readSite().catch(() => null);
  return newInterfaceOn(workspace, site?.newInterfaceWorkspaces ?? []);
}
