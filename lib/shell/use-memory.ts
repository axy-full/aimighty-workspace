"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { ImportFrom, MemoryKind, MemoryView } from "@/lib/atomikMemoryText";

/**
 * The browser's side of Atomik memory (app/api/atomik/memory): read the
 * workspace's and a project's entries, and the five things a person does to
 * them — keep, edit or accept, forget, find what "forget …" is about, and
 * turn a paste from another assistant into entries to review. Every request
 * carries the workspace scope the page was drawn for; none of them spends.
 */

export type MemoryLoad = { status: "loading" | "ready" | "error"; entries: MemoryView[]; error: string | null };
export type ForgetFind = { subject: string; matches: (MemoryView & { selected: boolean })[] };
export type ImportReply = { entries: MemoryView[]; skipped: { money: number; duplicates: number; beyondLimit: number; invalid: number } };
export type AddInput = { kind: MemoryKind; text: string; projectId: string | null; assetId?: string | null; source?: "person" | "atomik"; origin?: string | null };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** Said on the window when memory changed somewhere else (the Inspector, the Agent): an open Memory page reads again. */
export const MEMORY_CHANGED = "particl:atomik-memory";

export function memoryApi(fetcher: Fetcher, changed?: () => void) {
  async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
    const response = await fetcher(url, {
      method, cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const reply = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok || !reply) throw new Error(reply?.error || "Memory could not be saved. Try again.");
    /* A read-only find changes nothing. */
    if (method !== "GET" && !(body && typeof body === "object" && (body as { action?: unknown }).action === "find")) changed?.();
    return reply;
  }
  return {
    add: (input: AddInput) => call<{ entry: MemoryView }>("/api/atomik/memory", "POST", { action: "add", ...input }).then((r) => r.entry),
    importText: (input: { text: string; projectId: string | null; from: ImportFrom }) => call<ImportReply>("/api/atomik/memory", "POST", { action: "import", ...input }),
    find: (text: string, projectId: string | null) => call<ForgetFind>("/api/atomik/memory", "POST", { action: "find", text, projectId }),
    forget: (ids: string[], reason: "forgotten" | "dismissed" = "forgotten") => call<{ forgotten: number }>("/api/atomik/memory", "POST", { action: "forget", ids, reason }).then((r) => r.forgotten),
    update: (id: string, patch: { text?: string; kind?: MemoryKind; projectId?: string | null; accept?: boolean; updatedAt?: number }) =>
      call<{ entry: MemoryView }>(`/api/atomik/memory/${encodeURIComponent(id)}`, "PATCH", patch).then((r) => r.entry),
  };
}
export type MemoryApi = ReturnType<typeof memoryApi>;

/** The mutations alone, bound to the scope a surface was drawn for (the Agent, the Inspector). */
export function useMemoryApi(scope: string | null | undefined): MemoryApi {
  const scoped = useScopedFetch(scope ?? null);
  return useMemo(() => memoryApi(scoped, () => window.dispatchEvent(new Event(MEMORY_CHANGED))), [scoped]);
}

/** The Memory page's list for one project (null: the workspace's alone), read on arrival and after every change. */
export function useMemory(scope: string | null | undefined, projectId: string | null) {
  const scoped = useScopedFetch(scope ?? null);
  const api = useMemo(() => memoryApi(scoped), [scoped]);
  const key = JSON.stringify([scope ?? null, projectId]);
  const [load, setLoad] = useState<{ key: string; value: MemoryLoad } | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!scope) return;
    const mine = ++sequence.current;
    setLoad((previous) => ({ key, value: previous?.key === key ? { ...previous.value, status: previous.value.status === "error" ? "loading" : previous.value.status } : { status: "loading", entries: [], error: null } }));
    try {
      const response = await scoped(`/api/atomik/memory${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as { entries?: MemoryView[]; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.entries)) throw new Error(body?.error || "Memory could not be loaded.");
      if (mine === sequence.current) setLoad({ key, value: { status: "ready", entries: body.entries, error: null } });
    } catch (error) {
      if (mine !== sequence.current) return;
      const message = error instanceof Error && error.message !== "Failed to fetch" ? error.message : "Memory could not be loaded.";
      setLoad((previous) => ({ key, value: { status: "error", entries: previous?.key === key ? previous.value.entries : [], error: message } }));
    }
  }, [scope, projectId, key, scoped]);
  /* On arrival and whenever the scope or project changes; an answer for an earlier one lands on nothing (`sequence`). */
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    const again = () => void refresh();
    window.addEventListener(MEMORY_CHANGED, again);
    return () => { clearTimeout(timer); window.removeEventListener(MEMORY_CHANGED, again); };
  }, [refresh]);
  const value: MemoryLoad = load?.key === key ? load.value : { status: "loading", entries: [], error: null };
  return { ...value, refresh, api };
}
