/**
 * What a person wants to be told about, per workspace (brief 2.7).
 *
 * Four things happen that someone might want on their phone: a take they
 * asked for finished, a production reached most of its cap, a take is
 * waiting on them, and the balance is running out. Each person chooses
 * their own; the choice lives in the workspace, because the same person in
 * two workspaces is two different jobs. Pure — the store is elsewhere.
 */
export type NotifyKind = "takeDone" | "capNear" | "approvalNeeded" | "balanceLow";
export const NOTIFY_KINDS: NotifyKind[] = ["takeDone", "capNear", "approvalNeeded", "balanceLow"];

export const NOTIFY_LABELS: Record<NotifyKind, { title: string; line: string; adminOnly?: boolean }> = {
  takeDone: { title: "A take you asked for finished", line: "Only your own — not everything the team renders." },
  capNear: { title: "A production nears its cap", line: "At the share of the cap set under Defaults & caps.", adminOnly: true },
  approvalNeeded: { title: "A take is waiting on you", line: "When someone picks a take for you to approve." },
  balanceLow: { title: "The balance is running out", line: "When renders start being held, and when credits arrive.", adminOnly: true },
};

/** Everything on, until someone says otherwise: a notification nobody asked for is worse than one nobody needed. */
export const NOTIFY_DEFAULT: Record<NotifyKind, boolean> = { takeDone: true, capNear: true, approvalNeeded: true, balanceLow: true };

export function cleanPrefs(v: unknown): Record<NotifyKind, boolean> {
  const out = { ...NOTIFY_DEFAULT };
  if (!v || typeof v !== "object") return out;
  for (const kind of NOTIFY_KINDS) {
    const on = (v as Record<string, unknown>)[kind];
    if (typeof on === "boolean") out[kind] = on;
  }
  return out;
}

/** Who, of the people asked for, wants this kind — and an admin-only kind never reaches a member. */
export function wants(kind: NotifyKind, people: { id: string; role?: string; prefs?: unknown }[]): string[] {
  const adminOnly = Boolean(NOTIFY_LABELS[kind].adminOnly);
  return people
    .filter((p) => (!adminOnly || p.role === "admin" || p.role === "owner") && cleanPrefs(p.prefs)[kind])
    .map((p) => p.id);
}
