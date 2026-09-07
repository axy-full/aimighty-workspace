/** The three things that must be true before a workspace is deleted: the owner asks, by its exact name, and it is not the studio's own. Pure. */
export function deletionAllowed(ws: { name: string; legacy: boolean; role: string | null }, typedName: string): { ok: true } | { ok: false; error: string } {
  if (ws.legacy) return { ok: false, error: "The studio's own workspace is the platform; it cannot be deleted from here." };
  if (ws.role !== "owner") return { ok: false, error: "Only the owner deletes a workspace." };
  if (typedName.trim() !== ws.name.trim()) return { ok: false, error: "Type the workspace's name exactly as it is to confirm." };
  return { ok: true };
}
