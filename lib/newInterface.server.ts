import { newInterfaceOn } from "./newInterface";
import { engineMock } from "./mock";
import { readSite, workspaceNewInterfaceOff } from "./site/settings.server";

/* What the switch reads, held for 10 s per process (as the platform layer is), so the shell and /api/me don't each add reads. */
const HOLD_MS = 10_000;
const held = new Map<string, { at: number; value: Promise<{ everyone: boolean; workspaceOff: boolean }> }>();

function read(workspaceId: string) {
  return Promise.all([readSite().then((s) => s.newInterfaceEveryone, () => true), workspaceNewInterfaceOff(workspaceId)]).then(([everyone, workspaceOff]) => ({ everyone, workspaceOff }));
}

/** The switch for a session's workspace: on unless the owner turned the new interface off for everyone or listed this workspace; a setting that can't be read means on. */
export async function newInterfaceFor(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!workspace) return false;
  /* A local mock server (the browser specs) reads afresh, so a workspace a spec has just listed sees the switch at once. */
  if (engineMock()) return newInterfaceOn(workspace, await read(workspace.id));
  const at = Date.now();
  let entry = held.get(workspace.id);
  if (!entry || at - entry.at > HOLD_MS) { entry = { at, value: read(workspace.id) }; held.set(workspace.id, entry); if (held.size > 500) held.delete(held.keys().next().value!); }
  return newInterfaceOn(workspace, await entry.value);
}
