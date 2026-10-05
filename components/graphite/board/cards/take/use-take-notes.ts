"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { TakeNote } from "./take-model";

/*
 * The team's notes on a take (GET /api/notes?genId=, the existing per-take review talk; a reject's reason is one),
 * read once per take however many cards show them, and read again after this person adds one. Reading is free.
 */

type Entry = { notes: readonly TakeNote[] | null; at: number };
const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const FRESH_MS = 15_000;
const keyOf = (scope: string, genId: string) => `${scope}\n${genId}`;
const emit = () => { for (const l of listeners) l(); };

type Row = { text?: unknown; author?: unknown; createdAt?: unknown; guest?: unknown };

function read(scope: string, genId: string): Promise<void> {
  const key = keyOf(scope, genId);
  const running = inflight.get(key);
  if (running) return running;
  const job = fetch(`/api/notes?${new URLSearchParams({ genId })}`, { cache: "no-store", headers: { "X-Workbench-Scope": scope } })
    .then(async (response) => {
      const json = await response.json().catch(() => null) as { notes?: Row[] } | null;
      if (!response.ok || !Array.isArray(json?.notes)) throw new Error("not read");
      const notes = json.notes.flatMap((n): TakeNote[] => typeof n.text === "string" && typeof n.createdAt === "number"
        ? [{ author: typeof n.author === "string" && n.author ? n.author : "Someone", text: n.text, at: n.createdAt }] : []);
      store.set(key, { notes, at: Date.now() });
    })
    /* A read that failed keeps what was read before: the history just shows no notes yet. */
    .catch(() => { store.set(key, { notes: store.get(key)?.notes ?? null, at: Date.now() }); })
    .finally(() => { inflight.delete(key); emit(); });
  inflight.set(key, job);
  return job;
}

/** Read one take's notes again now (after this person wrote one). */
export function refreshTakeNotes(scope: string, genId: string): void {
  void read(scope, genId);
}

/** The notes on each of `genIds`, by generation id; takes not read yet are absent. */
export function useTakeNotes(scope: string, genIds: readonly string[]): ReadonlyMap<string, readonly TakeNote[]> {
  const ids = genIds.join(",");
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    for (const id of ids ? ids.split(",") : []) {
      const was = store.get(keyOf(scope, id));
      if (!was || Date.now() - was.at > FRESH_MS) void read(scope, id);
    }
    return () => { listeners.delete(listener); };
  }, [scope, ids]);
  const snapshot = useCallback(() => (ids ? ids.split(",").map((id) => store.get(keyOf(scope, id))?.at ?? 0).join(",") : ""), [scope, ids]);
  const version = useSyncExternalStore(subscribe, snapshot, () => "");
  return useMemo(() => {
    void version;
    const out = new Map<string, readonly TakeNote[]>();
    for (const id of ids ? ids.split(",") : []) {
      const notes = store.get(keyOf(scope, id))?.notes;
      if (notes) out.set(id, notes);
    }
    return out;
  }, [scope, ids, version]);
}
