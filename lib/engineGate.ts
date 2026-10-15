import { isHouseWorkspace } from "./houseWorkspace";

/**
 * Who may use an engine (owner, 15 Oct 2026, 22:15): "ON for the house workspace (ws_legacy) and any workspace I list
 * in the site setting; OFF for customer workspaces until launch."
 *
 * An engine is offered to a workspace only when BOTH are true:
 *  1. the engine's own switch is on (the global kill switch, an environment setting read at run time), and
 *  2. the workspace is the house workspace (lib/houseWorkspace.ts) or is listed in the site setting
 *     `enginesOnWorkspaces` (lib/site/settings.ts), one list for every engine.
 * Pure: no database, no environment read, safe on the client. The server half is lib/engineGate.server.ts.
 */

/** Each engine's own switch. Exports are the first; the provider engines of docs/plans/provider-adapters.md follow. */
export const ENGINE_SWITCH = Object.freeze({
  remotion: "REMOTION_EXPORTS",
} as const);
export type EngineName = keyof typeof ENGINE_SWITCH;

/** A switch value that means on: exactly 1, on, true or yes (any case, spaces ignored). Anything else, or nothing, is off. */
export function switchOn(value: string | undefined | null): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

/** The engine's own switch, read from the given environment. */
export function engineSwitchOn(engine: EngineName, env: Readonly<Record<string, string | undefined>>): boolean {
  return switchOn(env[ENGINE_SWITCH[engine]]);
}

/** Whether the workspace is allowed an engine whose switch is on: the house workspace, or one the platform owner listed. */
export function workspaceMayUseEngines(workspace: { id: string } | null | undefined, listed: readonly string[] = []): boolean {
  if (!workspace) return false;
  return isHouseWorkspace(workspace) || listed.includes(workspace.id);
}

/** The whole rule: the engine's switch is on AND the workspace is the house or listed. */
export function engineEnabled(
  engine: EngineName,
  workspace: { id: string } | null | undefined,
  listed: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return engineSwitchOn(engine, env) && workspaceMayUseEngines(workspace, listed);
}
