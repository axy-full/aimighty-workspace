/**
 * A prompt carried into Generate from a screen that writes one but does not
 * render — the shot builder's subject line with its Setup as words.
 *
 * The builder used to write three localStorage keys that nothing read, clear
 * its own drafts and navigate away, so the person's picks were simply gone.
 * This is the one hand-off with a receiver: Generate (components/make/
 * GenWorkspace.tsx) takes it once, hands it to the composer, and only then
 * clears it. Session storage, keyed by workspace and account, so it never
 * crosses a tab, a workspace or a person; and it goes stale after ten minutes
 * so an abandoned hand-off never ambushes a later visit.
 */
export type ComposeHandoff = { prompt: string; kind: "video" | "image"; at: number };

const PREFIX = "particl:compose-handoff";
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

export const handoffKey = (workspaceId: string | null | undefined, email: string | null | undefined): string =>
  `${PREFIX}:${JSON.stringify([workspaceId ?? "", email ?? ""])}`;

/** The subject line, then the Setup — the words the composer reads its rows from. */
export function handoffPrompt(prose: string, phrase: string): string {
  const subject = prose.trim();
  const setup = phrase.trim();
  if (!setup) return subject;
  if (!subject) return `${setup}.`;
  return `${/[.!?]$/.test(subject) ? subject : `${subject}.`} ${setup}.`;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function writeComposeHandoff(store: Store | null | undefined, workspaceId: string | null | undefined, email: string | null | undefined, handoff: Omit<ComposeHandoff, "at">, now = Date.now()): boolean {
  if (!store || !handoff.prompt.trim()) return false;
  try {
    store.setItem(handoffKey(workspaceId, email), JSON.stringify({ ...handoff, at: now }));
    return true;
  } catch {
    return false;
  }
}

export function readComposeHandoff(store: Store | null | undefined, workspaceId: string | null | undefined, email: string | null | undefined, now = Date.now()): ComposeHandoff | null {
  if (!store) return null;
  try {
    const raw = store.getItem(handoffKey(workspaceId, email));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ComposeHandoff>;
    if (typeof value.prompt !== "string" || !value.prompt.trim()) return null;
    if (value.kind !== "video" && value.kind !== "image") return null;
    if (typeof value.at !== "number" || now - value.at > HANDOFF_TTL_MS || value.at > now + 60_000) return null;
    return { prompt: value.prompt, kind: value.kind, at: value.at };
  } catch {
    return null;
  }
}

export function clearComposeHandoff(store: Store | null | undefined, workspaceId: string | null | undefined, email: string | null | undefined): void {
  try { store?.removeItem(handoffKey(workspaceId, email)); } catch { /* storage blocked: nothing was kept */ }
}
