import { isHouseWorkspace } from "./houseWorkspace";

/**
 * Who sees the interface being built from design/particl-prototype-12 (docs/redesign-plan.md).
 *
 * Off for every customer workspace. On for the house workspace (lib/houseWorkspace.ts), and for any workspace the
 * platform owner lists in the site setting `newInterfaceWorkspaces` (lib/site/settings.ts), which is also how the
 * browser tests and the screenshot tool see it. Its own field in the `site` row: the switch deleted on 6 Oct
 * (`platform_layer` key `interface`) is never read. Pure: no database, safe on the client.
 */
export function newInterfaceOn(workspace: { id: string } | null | undefined, listed: readonly string[] = []): boolean {
  if (!workspace) return false;
  return isHouseWorkspace(workspace) || listed.includes(workspace.id);
}
