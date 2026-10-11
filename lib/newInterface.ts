/**
 * Who sees the interface built from design/particl-prototype-12 (docs/redesign-plan.md): every workspace (owner, 11 October 2026),
 * except the ones the platform owner has listed as off in the site setting `newInterfaceOff` (lib/site/settings.ts): the owner's
 * way back, one workspace at a time and with no deploy. A signed-in person always has a workspace, so the only other "off" is no
 * workspace at all (signed out). The visitor pages stay behind their own setting (`visitorPages`, off). Pure: no database, safe
 * on the client.
 */
export function newInterfaceOn(workspace: { id: string } | null | undefined, off: readonly string[] = []): boolean {
  return Boolean(workspace) && !off.includes(workspace!.id);
}
