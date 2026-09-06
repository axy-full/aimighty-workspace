"use client";

/**
 * Typed words survive leaving the room.
 *
 * Every screen is its own React tree, so walking to another page unmounts
 * the box you were typing in and the words go with it. `lib/draft.ts` fixed
 * that for the three composers; this is the same idea for everything else
 * that takes typing — the agent's prompt, a new idea, the shot builder's
 * subject line, a note in the margin, a chat message — as a hook, so a
 * field opts in with one line.
 *
 * Kept in localStorage under the same `aw_draft:` prefix the sign-out wipe
 * clears, scoped by workspace so a draft never follows someone into another
 * team's room, and read back only for someone signed in (see lib/draft.ts
 * for why the read is the right place to refuse). Written on a timer, not
 * per keystroke; flushed on unmount so the last half-second of typing is
 * not the half-second that gets lost. Cleared by the caller when the words
 * are actually sent, and quietly dropped after two weeks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";

const PREFIX = "aw_draft:";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Long enough for a treatment's worth of notes, short enough not to bloat storage. */
const MAX_CHARS = 16_000;

type Stored<T> = { v: T; at: number };

/** Nothing worth keeping: an empty string, list, or an object of those. */
export function isBlankDraft(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(isBlankDraft);
  return false;
}

const keyFor = (workspaceId: string | null | undefined, surface: string) =>
  `${PREFIX}${workspaceId ?? "-"}:${surface}`;

function readStored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored<T>;
    if (!s || typeof s.at !== "number" || Date.now() - s.at > TTL_MS || isBlankDraft(s.v)) {
      localStorage.removeItem(key);
      return null;
    }
    return s.v;
  } catch {
    return null;   // private mode, or a draft we can't read
  }
}

function writeStored<T>(key: string, v: T): void {
  try {
    if (isBlankDraft(v)) { localStorage.removeItem(key); return; }
    const raw = JSON.stringify({ v, at: Date.now() } satisfies Stored<T>);
    if (raw.length <= MAX_CHARS) localStorage.setItem(key, raw);
  } catch { /* storage full or disabled — nothing worth interrupting for */ }
}

/** Peek at a draft without a hook — for a mount effect deciding what wins. */
export function peekDraft<T>(workspaceId: string | null | undefined, surface: string): T | null {
  return readStored<T>(keyFor(workspaceId, surface));
}

export function useDraft<T>(surface: string, initial: T): {
  value: T;
  set: (next: T | ((prev: T) => T)) => void;
  clear: () => void;
  /** True once a stored draft has been put back into `value`. */
  restored: boolean;
} {
  const { signedIn, workspace } = useSession();
  const key = keyFor(workspace?.id, surface);
  const [value, setValue] = useState<T>(initial);
  const [restored, setRestored] = useState(false);
  const dirty = useRef(false);
  const loadedKey = useRef<string | null>(null);
  const latest = useRef<{ key: string; value: T }>({ key, value: initial });

  // Read back once per key. Applied in a microtask, never during render:
  // the server has no localStorage, so seeding at first paint hydrates wrong.
  useEffect(() => {
    if (!signedIn || loadedKey.current === key) return;
    loadedKey.current = key;
    const found = readStored<T>(key);
    if (found === null) return;
    Promise.resolve().then(() => { setValue(found); setRestored(true); });
  }, [key, signedIn]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    dirty.current = true;
    setValue(next);
  }, []);

  // Written 400ms after the last change — localStorage is synchronous and
  // on the main thread, and a long paragraph written per keystroke is felt.
  useEffect(() => {
    latest.current = { key, value };
    if (!dirty.current) return;
    const t = setTimeout(() => writeStored(key, value), 400);
    return () => clearTimeout(t);
  }, [key, value]);

  // Flush on unmount, so leaving the room mid-word keeps the word.
  useEffect(() => () => {
    if (dirty.current) writeStored(latest.current.key, latest.current.value);
  }, []);

  const clear = useCallback(() => {
    dirty.current = false;
    try { localStorage.removeItem(latest.current.key); } catch { /* private mode */ }
    setValue(initial);
    setRestored(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { value, set, clear, restored };
}
