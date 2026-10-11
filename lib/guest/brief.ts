/**
 * What a guest typed on guest Home, kept in this browser so it becomes their first board after sign-up (lead
 * decision 39). Text and the two chips only: a guest's files never leave the device. Seven days, then it is
 * forgotten. Pure helpers plus a guarded localStorage reader and writer; nothing here talks to a server.
 */
import { TEMPLATES, cleanDraft, newProjectFor, type HomeDraft, type HomeSeed } from "@/components/graphite/home/home-model";

export const GUEST_BRIEF_KEY = "particl:guest-brief";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Stored = { v: HomeDraft; at: number };

/** The stored value, cleaned; null when missing, unreadable, empty or older than seven days. */
export function decodeGuestBrief(raw: string | null, now = Date.now()): HomeDraft | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<Stored>;
    if (!stored || typeof stored.at !== "number" || now - stored.at > TTL_MS || stored.at > now + 60_000) return null;
    const draft = cleanDraft(stored.v);
    return draft.text.trim() || draft.aspect || draft.length ? draft : null;
  } catch {
    return null;
  }
}

/** The stored string as it is (a stable snapshot for useSyncExternalStore); null when storage is blocked. */
export function guestBriefRaw(): string | null {
  try { return localStorage.getItem(GUEST_BRIEF_KEY); } catch { return null; }
}

/** Other tabs' changes (the storage event); this tab's own writes are read through its own state. */
export function subscribeGuestBrief(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

export function readGuestBrief(): HomeDraft | null {
  return decodeGuestBrief(guestBriefRaw());
}

/** Saves the box as it is; an empty box forgets what was kept. */
export function saveGuestBrief(draft: HomeDraft): void {
  try {
    const clean = cleanDraft(draft);
    if (!clean.text.trim() && !clean.aspect && !clean.length) localStorage.removeItem(GUEST_BRIEF_KEY);
    else localStorage.setItem(GUEST_BRIEF_KEY, JSON.stringify({ v: clean, at: Date.now() } satisfies Stored));
  } catch { /* private storage: the brief lives as long as the page */ }
}

export function clearGuestBrief(): void {
  try { localStorage.removeItem(GUEST_BRIEF_KEY); } catch { /* nothing kept */ }
}

/** The first board, as Home's Film template would make it from this box (components/graphite/home/home-model.ts). */
export function firstBoard(draft: HomeDraft): { name: string; seed: HomeSeed } {
  return newProjectFor(TEMPLATES[0], draft);
}
