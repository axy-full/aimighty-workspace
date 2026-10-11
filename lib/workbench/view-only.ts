/**
 * A teammate's board opens view-only (lib/workbench/team-boards.ts): the words, in one place for the server and the screens.
 * The server answers a read of such a board with `viewOnly: { owner }`; the board then refuses every edit and never saves.
 */
export type ViewOnly = { owner: { id: string; name: string; support?: true } };
/** What the stage header says. */
export const viewOnlyLine = (ownerName: string) => `${ownerName}’s board · view only`;
/** What an edit, or a save the server refuses, says. */
export const viewOnlyRefusal = (ownerName: string) => `This is ${ownerName}’s board; it opens view-only here, so it was not saved.`;
