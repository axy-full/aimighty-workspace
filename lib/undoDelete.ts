"use client";

/**
 * Delete with Undo (docs/change-request-1.md §10): the card leaves the
 * screen at once, the request goes 30 seconds later, and the toast's Undo
 * cancels it. The timers live here, not in a component, so leaving the
 * page does not quietly cancel a delete the user asked for — a delete
 * they did not undo still happens.
 */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleDelete(id: string, run: () => void | Promise<void>, ms = 30_000): void {
  cancelDelete(id);
  pending.set(id, setTimeout(() => { pending.delete(id); void run(); }, ms));
}

/** True when there was a delete to undo. */
export function cancelDelete(id: string): boolean {
  const t = pending.get(id);
  if (!t) return false;
  clearTimeout(t); pending.delete(id);
  return true;
}
