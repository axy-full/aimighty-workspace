"use client";

/**
 * A prompt survives leaving the room.
 *
 * Each composer is its own React tree, so moving between Video, Images and
 * Audio unmounts the one you were typing in and the words go with it. That
 * is a small loss every time and an infuriating one when the paragraph took
 * a while to write, which the good ones do.
 *
 * So a draft is kept per surface, written as you type and read back when you
 * return. Cleared only when the render is actually submitted: a failed
 * submit keeps the words, because that is exactly when you least want to
 * retype them.
 *
 * Deliberately per surface rather than shared. The three composers ask for
 * different things, and carrying a line of dialogue into the video prompt
 * would be worse than losing it.
 */

const KEY = (surface: string) => `aw_draft:${surface}`;
/** Long enough to be a draft, short enough not to bloat localStorage. */
const MAX = 8000;

/**
 * Read a draft back — but never for somebody who is not signed in.
 *
 * The sign-out wipe clears these, and it is not enough on its own: it runs
 * in an effect, and a composer reads its draft while mounting, so on the
 * first paint after a sign-out the previous person's unsent prompt was
 * restored into the box before the wipe caught up. Refusing at the READ
 * closes that window whatever order things run in.
 *
 * `signedIn` is passed in rather than sniffed here: the session cookie is
 * httpOnly, so document.cookie cannot see it and any check based on it
 * would silently return "" for everyone. The caller is inside the session
 * provider and simply knows.
 */
export function loadDraft(surface: string, signedIn: boolean): string {
  if (!signedIn) return "";
  try {
    return (localStorage.getItem(KEY(surface)) ?? "").slice(0, MAX);
  } catch {
    return "";   // private mode, or storage disabled
  }
}

/**
 * Written on a timer rather than on every keystroke: localStorage is
 * synchronous and on the main thread, so writing a long prompt on each
 * character is felt as typing lag on a slower machine.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function saveDraft(surface: string, value: string): void {
  const existing = timers.get(surface);
  if (existing) clearTimeout(existing);
  timers.set(surface, setTimeout(() => {
    timers.delete(surface);
    try {
      if (value.trim()) localStorage.setItem(KEY(surface), value.slice(0, MAX));
      else localStorage.removeItem(KEY(surface));
    } catch { /* nothing to be done, and nothing worth interrupting for */ }
  }, 400));
}

export function clearDraft(surface: string): void {
  const existing = timers.get(surface);
  if (existing) { clearTimeout(existing); timers.delete(surface); }
  try { localStorage.removeItem(KEY(surface)); } catch { /* private mode */ }
}
