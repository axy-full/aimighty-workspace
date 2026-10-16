/**
 * ⌘J on a board (owner, 15 Oct: Atomik's button is inside the ⌘K bar on app screens and absent on a board, where ⌘J opens it): the header asks the open board to
 * open or close its own Atomik dock (components/graphite/board/agent), whose state the board holds. A window event, so neither knows the other.
 */
export const ATOMIK_DOCK_TOGGLE = "v12:atomik-dock-toggle";

export function toggleAtomikDock(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ATOMIK_DOCK_TOGGLE));
}
