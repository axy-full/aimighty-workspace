/**
 * The "new interface" switch, as data (pure: no React, no database, safe in the browser bundle, a server route
 * and a test alike).
 *
 * The switch is per workspace. It lives in ONE row of the platform database's existing key/value table
 * (`platform_layer`, key `interface`): no migration, no environment variable. Only the platform owner writes it,
 * from /admin (lib/shell/new-interface.server.ts). A workspace with the switch off sees today's interface,
 * whatever else is shipped.
 */
export const INTERFACE_ROW = "interface";

export type InterfaceRollout = {
  /** Every workspace. Flipped last, by the owner, in the same change that deletes the old screens (docs/old-shells.md). */
  everyone: boolean;
  /** The workspaces it is on for before that: the owner's own, and the demo workspace. */
  workspaces: string[];
};

const MAX_WORKSPACES = 500;
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;

/** What is stored, made safe: well-formed ids only, no repeats, at most 500; anything else reads as off. */
export function cleanRollout(value: unknown): InterfaceRollout {
  const raw = value && typeof value === "object" ? (value as { everyone?: unknown; workspaces?: unknown }) : {};
  const seen = new Set<string>();
  if (Array.isArray(raw.workspaces)) {
    for (const id of raw.workspaces) {
      if (typeof id === "string" && ID.test(id)) seen.add(id);
      if (seen.size >= MAX_WORKSPACES) break;
    }
  }
  return { everyone: raw.everyone === true, workspaces: [...seen] };
}

/** Whether the switch is on for this workspace. A missing workspace is never on. */
export function rolloutIncludes(rollout: InterfaceRollout, workspaceId: string | null | undefined): boolean {
  if (!workspaceId) return false;
  return rollout.everyone === true || rollout.workspaces.includes(workspaceId);
}

/** The rollout with one workspace turned on or off. The list stays within its bound; turning on at the bound is refused (null). */
export function withWorkspace(rollout: InterfaceRollout, workspaceId: string, on: boolean): InterfaceRollout | null {
  if (!ID.test(workspaceId)) return null;
  const rest = rollout.workspaces.filter((id) => id !== workspaceId);
  if (!on) return { ...rollout, workspaces: rest };
  if (rest.length >= MAX_WORKSPACES) return null;
  return { ...rollout, workspaces: [...rest, workspaceId] };
}
