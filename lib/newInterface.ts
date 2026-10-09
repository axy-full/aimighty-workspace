/**
 * Who sees the interface being built from design/particl-prototype-12 (docs/redesign-plan.md).
 *
 * Off for every customer workspace. On for the platform's own house workspace (the legacy primary, slug "aimighty"),
 * and for any workspace the platform owner names in the site settings (`newInterfaceWorkspaces`, /admin), which is
 * also how the browser tests and the screenshot tool see it. Pure: no database, safe on the client.
 */
export type NewInterfaceWorkspace = { id: string; legacy?: boolean | null };

export function newInterfaceOn(workspace: NewInterfaceWorkspace | null | undefined, listed: readonly string[] = []): boolean {
  if (!workspace) return false;
  return workspace.legacy === true || listed.includes(workspace.id);
}
