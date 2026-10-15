import { engineEnabled, engineSwitchOn, type EngineName } from "./engineGate";
import { engineMock } from "./mock";
import { readSite } from "./site/settings.server";

/* The list, held for 10 s per process (as lib/newInterface.server.ts does), so a route and its helpers don't each add a read. */
const HOLD_MS = 10_000;
let held: { at: number; ids: Promise<string[]> } | null = null;

function listed(): Promise<string[]> {
  /* A local mock server (the browser and unit specs) reads afresh, so a workspace a spec has just listed sees the switch at once. */
  if (engineMock()) return readSite().then((s) => s.enginesOnWorkspaces, () => []);
  if (!held || Date.now() - held.at > HOLD_MS) held = { at: Date.now(), ids: readSite().then((s) => s.enginesOnWorkspaces, () => []) };
  return held.ids;
}

/**
 * Is this engine on for this workspace? The engine's switch is read first, so with it off nothing else is read at all.
 * A site row that can't be read means off (readSite fails closed).
 */
export async function engineEnabledFor(
  engine: EngineName,
  workspace: { id: string } | null | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  if (!workspace || !engineSwitchOn(engine, env)) return false;
  return engineEnabled(engine, workspace, await listed(), env);
}
