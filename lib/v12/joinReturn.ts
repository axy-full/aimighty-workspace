/**
 * After joining, the person lands back where they were (docs/redesign/inventory.md § 8.6): the visitor's Home or Make,
 * with what they typed in the bar and its price shown. The join sheet notes where the visitor was just before it sends
 * them to today's sign-up, invite or log-in page; the signed-in app reads the note once. Nothing here signs anyone in or
 * changes the sign-in pages: it is a note in this browser, read on the next signed-in page, kept a few hours at most.
 */
const KEY = "particl:join-return";
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type JoinReturn = "home" | "make";

/** Where the visitor was, from the page's own address (`/?guest=1&view=make` is Make; anything else is Home). */
export function joinReturnOf(back: string): JoinReturn {
  try { return new URL(back, "http://x").searchParams.get("view") === "make" ? "make" : "home"; } catch { return "home"; }
}

/** A stored note, made safe: only a fresh one with a known screen. */
export function readJoinReturn(raw: string | null, now = Date.now()): JoinReturn | null {
  if (!raw) return null;
  try {
    const note = JSON.parse(raw) as { at?: unknown; view?: unknown };
    if (typeof note.at !== "number" || now - note.at < 0 || now - note.at > MAX_AGE_MS) return null;
    return note.view === "make" || note.view === "home" ? note.view : null;
  } catch { return null; }
}

export function saveJoinReturn(back: string, now = Date.now()): void {
  try { window.localStorage.setItem(KEY, JSON.stringify({ at: now, view: joinReturnOf(back) })); } catch { /* storage off: they land on Home as today */ }
}

/** The note, once: read and removed. */
export function takeJoinReturn(now = Date.now()): JoinReturn | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    window.localStorage.removeItem(KEY);
    return readJoinReturn(raw, now);
  } catch { return null; }
}
