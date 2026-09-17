"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSession } from "@/lib/session";

const PREFIX = "aw_draft:v2:";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CHARS = 16_000;
const eventName = "particl-draft-storage";
type Stored<T> = { v: T; at: number };
type Edit<T> = {
  key: string | null;
  value: T;
  dirty: boolean;
  restored: boolean;
};

export function isBlankDraft(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>).every(isBlankDraft);
  return false;
}

/** Legacy workspace-only keys cannot be attributed to an account and are never imported. */
export const draftStorageKey = (
  workspaceId: string,
  email: string,
  surface: string,
) => `${PREFIX}${JSON.stringify([workspaceId, email.toLowerCase(), surface])}`;
const subscribe = (callback: () => void) => {
  window.addEventListener("storage", callback);
  window.addEventListener(eventName, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(eventName, callback);
  };
};
const serverSnapshot = () => null;
function readRaw(key: string | null) {
  try {
    return key ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}
function decode<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Stored<T>;
    return stored &&
      typeof stored.at === "number" &&
      Date.now() - stored.at <= TTL_MS &&
      !isBlankDraft(stored.v)
      ? stored.v
      : null;
  } catch {
    return null;
  }
}
function writeStored<T>(key: string, value: T) {
  try {
    if (isBlankDraft(value)) localStorage.removeItem(key);
    else {
      const raw = JSON.stringify({
        v: value,
        at: Date.now(),
      } satisfies Stored<T>);
      if (raw.length <= MAX_CHARS) localStorage.setItem(key, raw);
    }
    window.dispatchEvent(new Event(eventName));
  } catch {
    /* Private storage can be unavailable; the current editor remains usable. */
  }
}

export function peekDraft<T>(
  workspaceId: string | null | undefined,
  email: string | null | undefined,
  surface: string,
): T | null {
  return workspaceId && email
    ? decode<T>(readRaw(draftStorageKey(workspaceId, email, surface)))
    : null;
}

/** Private drafts hydrate after SSR; scoped edits disappear synchronously when identity changes. */
export function useDraft<T>(
  surface: string,
  initial: T,
): {
  value: T;
  set: (next: T | ((previous: T) => T)) => void;
  clear: () => void;
  restored: boolean;
} {
  const { signedIn, workspace, email } = useSession();
  const key =
    signedIn && workspace?.id && email
      ? draftStorageKey(workspace.id, email, surface)
      : null;
  const snapshot = useCallback(() => readRaw(key), [key]);
  const stored = decode<T>(
    useSyncExternalStore(subscribe, snapshot, serverSnapshot),
  );
  const [edit, setEdit] = useState<Edit<T> | null>(null);
  const pending = useRef(new Map<string, T>());
  const current = edit?.key === key ? edit : null;
  const value = current ? current.value : (stored ?? initial);
  const restored = current ? current.restored : stored !== null;
  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      setEdit((previous) => {
        const own = previous?.key === key ? previous : null;
        const before = own ? own.value : (stored ?? initial);
        return {
          key,
          value:
            typeof next === "function" ? (next as (v: T) => T)(before) : next,
          dirty: true,
          restored: own ? own.restored : stored !== null,
        };
      });
    },
    [key, stored, initial],
  );

  useEffect(() => {
    if (!edit?.dirty || !key || edit.key !== key) return;
    const queue = pending.current;
    queue.set(key, edit.value);
    const timer = setTimeout(() => {
      writeStored(key, edit.value);
      queue.delete(key);
    }, 400);
    return () => clearTimeout(timer);
  }, [edit, key]);
  // A scope's cleanup writes only the draft captured for that scope. It can
  // never stamp a prior account's text into the next account's storage key.
  useEffect(() => {
    const queue = pending.current;
    const flush = () => {
      if (key && queue.has(key)) {
        writeStored(key, queue.get(key)!);
        queue.delete(key);
      }
    };
    // A hard reload does not unmount React. Flush this captured scope's last
    // keystrokes before the document exits, as well as on client navigation.
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [key]);
  const clear = useCallback(() => {
    if (key) {
      pending.current.delete(key);
      try {
        localStorage.removeItem(key);
        window.dispatchEvent(new Event(eventName));
      } catch {}
    }
    setEdit({ key, value: initial, dirty: false, restored: false });
  }, [key, initial]);
  return { value, set, clear, restored };
}
