"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SoulIdentityState } from "../workbench/soul-identity";

/**
 * The project's identities and the live training terms, from the existing
 * route the Cast stage reads (GET /api/soul/identities?projectId=). Polls
 * while one is training, as the workbench does. Shared by the Cast page and
 * its Inspector.
 */

export type IdentitiesState = { status: "idle" | "loading" | "ready" | "error"; data: SoulIdentityState | null; error: string | null };
const EMPTY: IdentitiesState = { status: "idle", data: null, error: null };
type Entry = { state: IdentitiesState; listeners: Set<() => void>; busy: boolean };
const entries = new Map<string, Entry>();
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);

function entry(key: string) {
  let found = entries.get(key);
  if (!found) entries.set(key, (found = { state: EMPTY, listeners: new Set(), busy: false }));
  return found;
}
function set(key: string, patch: Partial<IdentitiesState>) {
  const e = entry(key);
  e.state = { ...e.state, ...patch };
  e.listeners.forEach((l) => l());
}

async function load(scope: string, projectId: string) {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.busy) return;
  e.busy = true;
  if (e.state.status === "idle") set(key, { status: "loading" });
  try {
    const response = await fetch("/api/soul/identities?" + new URLSearchParams({ projectId }), { cache: "no-store", headers: { "X-Workbench-Scope": scope } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.identities)) throw new Error(body?.error || "Identities could not be loaded.");
    set(key, { status: "ready", data: body as SoulIdentityState, error: null });
  } catch (error) {
    set(key, { status: e.state.data ? "ready" : "error", error: error instanceof Error ? error.message : "Identities could not be loaded." });
  } finally {
    e.busy = false;
  }
}

export function useIdentities(scope: string, projectId: string | null) {
  const key = projectId ? keyOf(scope, projectId) : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    const e = entry(key);
    e.listeners.add(listener);
    return () => { e.listeners.delete(listener); };
  }, [key]);
  const state = useSyncExternalStore(subscribe, () => (key ? entry(key).state : EMPTY), () => EMPTY);
  const training = !!state.data?.identities.some((i) => i.status === "submitting" || i.status === "training");
  useEffect(() => {
    if (!projectId) return;
    void load(scope, projectId);
    if (!training) return;
    const timer = setInterval(() => void load(scope, projectId), 8_000);
    return () => clearInterval(timer);
  }, [scope, projectId, training]);
  return { state, refresh: useCallback(() => (projectId ? load(scope, projectId) : Promise.resolve()), [scope, projectId]) };
}
