/**
 * Where `/rig/canvas/new?project=…` lands once it has found or made the
 * project's board: the board, carrying every param it was given except
 * `project` — `shot` from a Shots grid's Open in Rig, `ref` from the Library's
 * Add to Canvas. It used to keep only `shot`, so a reference sent from the
 * Library never reached the board that was meant to place it.
 */
export function boardUrlFor(boardId: string, search: string): string {
  const query = new URLSearchParams(search);
  query.delete("project");
  const rest = query.toString();
  return `/rig/canvas/${encodeURIComponent(boardId)}${rest ? `?${rest}` : ""}`;
}
