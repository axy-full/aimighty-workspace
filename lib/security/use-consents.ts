"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ConsentRecord } from "./consent-words";

/**
 * A production's identity consent records (GET /api/identity-consents?projectId=), shared by the Cast card, its
 * consent dialog and the Inspector so they never disagree. Recording and withdrawing go through the same routes and
 * refresh the list. Session only: the route refuses tokens.
 */
export type ConsentsState = { status: "idle" | "loading" | "ready" | "error"; consents: ConsentRecord[]; error: string | null };
const EMPTY: ConsentsState = { status: "idle", consents: [], error: null };
type Entry = { state: ConsentsState; listeners: Set<() => void>; busy: Promise<void> | null };
const entries = new Map<string, Entry>();
const keyOf = (scope: string, projectId: string) => JSON.stringify([scope, projectId]);

function entry(key: string): Entry {
  let found = entries.get(key);
  if (!found) entries.set(key, (found = { state: EMPTY, listeners: new Set(), busy: null }));
  return found;
}
function set(key: string, patch: Partial<ConsentsState>) {
  const e = entry(key);
  e.state = { ...e.state, ...patch };
  e.listeners.forEach((l) => l());
}

async function load(scope: string, projectId: string): Promise<void> {
  const key = keyOf(scope, projectId);
  const e = entry(key);
  if (e.busy) return e.busy;
  if (e.state.status === "idle") set(key, { status: "loading" });
  e.busy = (async () => {
    try {
      const response = await fetch("/api/identity-consents?" + new URLSearchParams({ projectId }), { cache: "no-store", headers: { "X-Workbench-Scope": scope } });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.consents)) throw new Error(body?.error || "Consent records could not be read.");
      set(key, { status: "ready", consents: body.consents as ConsentRecord[], error: null });
    } catch (error) {
      set(key, { status: e.state.status === "ready" ? "ready" : "error", error: error instanceof Error ? error.message : "Consent records could not be read." });
    } finally {
      e.busy = null;
    }
  })();
  return e.busy;
}

export type ConsentDraft = {
  projectId: string; subjectKey: string; subjectLabel: string; personName: string;
  face: boolean; voice: boolean; uses: string[]; otherUse: string; until: string; recordingId: string; attested: boolean;
};

export function useConsents(scope: string | null, projectId: string | null) {
  const key = scope && projectId ? keyOf(scope, projectId) : null;
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};
    const e = entry(key);
    e.listeners.add(listener);
    return () => { e.listeners.delete(listener); };
  }, [key]);
  const state = useSyncExternalStore(subscribe, () => (key ? entry(key).state : EMPTY), () => EMPTY);
  useEffect(() => { if (scope && projectId) void load(scope, projectId); }, [scope, projectId]);
  const refresh = useCallback(() => (scope && projectId ? load(scope, projectId) : Promise.resolve()), [scope, projectId]);

  const record = useCallback(async (draft: ConsentDraft): Promise<{ consent: ConsentRecord | null; error: string | null }> => {
    if (!scope) return { consent: null, error: "Reload this page before recording consent." };
    try {
      const response = await fetch("/api/identity-consents", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: JSON.stringify(draft) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.consent) return { consent: null, error: body?.error ?? "The consent could not be recorded. Try again." };
      await refresh();
      return { consent: body.consent as ConsentRecord, error: null };
    } catch {
      return { consent: null, error: "The consent could not be recorded. Check the connection and try again." };
    }
  }, [scope, refresh]);

  const withdraw = useCallback(async (id: string): Promise<string | null> => {
    if (!scope) return "Reload this page first.";
    try {
      const response = await fetch(`/api/identity-consents/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Workbench-Scope": scope } });
      const body = await response.json().catch(() => null);
      if (!response.ok) return body?.error ?? "The consent could not be withdrawn.";
      await refresh();
      return null;
    } catch {
      return "The consent could not be withdrawn. Check the connection and try again.";
    }
  }, [scope, refresh]);

  return { state, refresh, record, withdraw };
}
