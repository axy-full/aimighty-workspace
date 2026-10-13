/**
 * Whose board an open draft is, when it is a teammate's opened to edit ("Can edit"): remembered here for the page, by draft id, so every request that acts
 * on the board names the owner (`owner` on a save, a map-shot, a check) and none of them has to guess. Set when the board is opened (the Rig's load),
 * cleared when it is opened as the person's own. The server settles anything that arrives without it (lib/workbench/team-boards.ts › boardKeyFor), and
 * refuses what it cannot.
 */
const owners = new Map<string, string>();

export function setActingOwner(draftId: string, owner: string | null): void {
  if (owner) owners.set(draftId, owner);
  else owners.delete(draftId);
}

/** `{ owner }` to spread into a request body for this draft, or nothing for the person's own board. */
export function actingOwnerField(draftId: string): { owner?: string } {
  const owner = owners.get(draftId);
  return owner ? { owner } : {};
}
