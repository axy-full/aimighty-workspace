/**
 * Who sees the interface built from design/particl-prototype-14 (docs/redesign-plan.md): every workspace (owner, 11 October 2026),
 * except when the platform owner turns "New interface for everyone" off (then nobody, with no deploy) or keeps one workspace on
 * today's screens (lib/site/settings.ts: `newInterfaceEveryone`, and one `ni_off:<workspace id>` row per workspace). A signed-in
 * person always has a workspace, so the only other "off" is no workspace at all (signed out). The visitor pages stay behind their
 * own setting (`visitorPages`, off). Pure: no database, safe on the client.
 */
export function newInterfaceOn(workspace: { id: string } | null | undefined, opts: { everyone?: boolean; workspaceOff?: boolean } = {}): boolean {
  return Boolean(workspace) && (opts.everyone ?? true) && !opts.workspaceOff;
}
