"use client";
import { useCallback, useSyncExternalStore } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import type { TakeVerification } from "@/lib/workbench/verify";

/*
 * A production's stored Verify checks (GET /api/workbench/development
 * ?verifications=1), read once per project however many cards, inspectors
 * and Takes tiles show them, and read again every 15 seconds while any is on
 * screen, so a teammate's finished check shows up without a reload. Reading
 * them is free.
 */

export type VerificationsState = { list: TakeVerification[] | null; error: string | null; at: number };
const EMPTY: VerificationsState = { list: null, error: null, at: 0 };
const POLL_MS = 15_000;
const FRESH_MS = 4_000;

const states = new Map<string, VerificationsState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const keyOf = (scope: string, projectId: string) => `${scope}\n${projectId}`;
const emit = (key: string) => { for (const listener of listeners.get(key) ?? []) listener(); };

/** Reads the project's checks now (one read at a time per project); every view of them updates. */
export function refreshVerifications(scope: string, projectId: string): Promise<void> {
  const key = keyOf(scope, projectId);
  const running = inflight.get(key);
  if (running) return running;
  const query = new URLSearchParams({ projectId, verifications: "1" });
  const read = studioRequest<{ verifications?: TakeVerification[] }>(`/api/workbench/development?${query}`, { headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
    .then((data) => { states.set(key, { list: Array.isArray(data.verifications) ? data.verifications : [], error: null, at: Date.now() }); })
    .catch((error: unknown) => {
      const was = states.get(key) ?? EMPTY;
      /* A read that failed keeps what was read before, and says so with its own Try again. */
      states.set(key, { ...was, error: error instanceof Error && error.message ? error.message : "The checks could not be read.", at: Date.now() });
    })
    .finally(() => { inflight.delete(key); emit(key); });
  inflight.set(key, read);
  return read;
}

export function useVerifications(scope: string, projectId: string | null | undefined) {
  const key = projectId ? keyOf(scope, projectId) : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!key || !projectId) return () => {};
    const set = listeners.get(key) ?? new Set<() => void>();
    set.add(listener);
    listeners.set(key, set);
    if (Date.now() - (states.get(key)?.at ?? 0) > FRESH_MS) void refreshVerifications(scope, projectId);
    if (!timers.has(key)) timers.set(key, setInterval(() => { if (!document.hidden) void refreshVerifications(scope, projectId); }, POLL_MS));
    return () => {
      set.delete(listener);
      if (set.size) return;
      listeners.delete(key);
      clearInterval(timers.get(key));
      timers.delete(key);
    };
  }, [key, scope, projectId]);
  const state = useSyncExternalStore(subscribe, () => (key ? states.get(key) ?? EMPTY : EMPTY), () => EMPTY);
  const refresh = useCallback(() => (projectId ? refreshVerifications(scope, projectId) : Promise.resolve()), [scope, projectId]);
  return { ...state, refresh };
}
