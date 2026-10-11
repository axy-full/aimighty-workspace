
/**
 * Who sees the interface built from design/particl-prototype-12 (docs/redesign-plan.md): every workspace (owner, 11 October 2026).
 *
 * It was off for customer workspaces and on for the house workspace and the ones the platform owner listed in the site setting
 * `newInterfaceWorkspaces` (lib/site/settings.ts, now unused here). A signed-in person always has a workspace, so the only
 * answer that is "off" is no workspace at all (signed out). The visitor pages stay behind their own setting (`visitorPages`, off).
 * Pure: no database, safe on the client.
 */
export function newInterfaceOn(workspace: { id: string } | null | undefined): boolean {
  return Boolean(workspace);
}
