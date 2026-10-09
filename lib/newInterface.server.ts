import { isHouseWorkspace } from "./houseWorkspace";
import { newInterfaceOn } from "./newInterface";
import { readSite } from "./site/settings.server";

/* The list, held for 10 s per process (as the platform layer is), so the shell and /api/me don't each add a read. */
const HOLD_MS = 10_000;
let held: { at: number; ids: Promise<string[]> } | null = null;

function listed(): Promise<string[]> {
  if (!held || Date.now() - held.at > HOLD_MS) held = { at: Date.now(), ids: readSite().then((s) => s.newInterfaceWorkspaces, () => []) };
  return held.ids;
}

/** The switch for a session's workspace, read from the site settings; a settings row that can't be read means off. */
export async function newInterfaceFor(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!workspace) return false;
  if (isHouseWorkspace(workspace)) return true;
  return newInterfaceOn(workspace, await listed());
}
