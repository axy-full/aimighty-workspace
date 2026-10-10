"use client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { EMPTY_TABS, parseTabs, pruneTabs, type TabsState } from "./tabs";

/**
 * The header's board tabs for this person and workspace (components/v12/shell/tabs.ts), kept in the browser under the
 * session's request scope, so another workspace's tabs never show here. Every header on the page shares one copy, and
 * another window of the same workspace follows along.
 */
const PREFIX = "particl:v12-tabs:";
const cache = new Map<string, TabsState>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function read(key: string): TabsState {
  const known = cache.get(key);
  if (known) return known;
  let state = EMPTY_TABS;
  try { state = parseTabs(window.localStorage.getItem(key)); } catch { /* storage off: tabs last as long as the page */ }
  cache.set(key, state);
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key?.startsWith(PREFIX)) { cache.delete(event.key); notify(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

export function useBoardTabs(scope: string | null, knownIds: ReadonlySet<string> | null) {
  const key = PREFIX + (scope ?? "none");
  const state = useSyncExternalStore(subscribe, () => read(key), () => EMPTY_TABS);
  const update = useCallback((change: (now: TabsState) => TabsState) => {
    const before = read(key);
    const after = change(before);
    if (after === before) return;
    cache.set(key, after);
    try { window.localStorage.setItem(key, JSON.stringify(after)); } catch { /* kept for this page only */ }
    notify();
  }, [key]);
  /* A board that was deleted, or is not this workspace's, drops out once the list is known. */
  useEffect(() => { update((now) => pruneTabs(now, knownIds)); }, [knownIds, update]);
  return useMemo(() => ({ state, update }), [state, update]);
}
