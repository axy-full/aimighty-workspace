import { newInterfaceOn } from "./newInterface";
import { engineMock } from "./mock";
import { readSite } from "./site/settings.server";

/* The opt-out list, held for 10 s per process (as the platform layer is), so the shell and /api/me don't each add a read. */
const HOLD_MS = 10_000;
let held: { at: number; ids: Promise<string[]> } | null = null;

function off(): Promise<string[]> {
  /* A local mock server (the browser specs) reads afresh, so a workspace a spec has just listed sees the switch at once. */
  if (engineMock()) return readSite().then((s) => s.newInterfaceOff, () => []);
  if (!held || Date.now() - held.at > HOLD_MS) held = { at: Date.now(), ids: readSite().then((s) => s.newInterfaceOff, () => []) };
  return held.ids;
}

/** The switch for a session's workspace: on unless the platform owner listed the workspace as off; a settings row that can't be read means on. */
export async function newInterfaceFor(workspace: { id: string } | null | undefined): Promise<boolean> {
  if (!workspace) return false;
  return newInterfaceOn(workspace, await off());
}
