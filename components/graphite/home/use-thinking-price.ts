"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { THINKING_READ_FAILED, thinkingFrom, type Thinking } from "@/lib/shell/thinking-price";

export { THINKING_READ_FAILED, thinkingFrom, type Thinking };

/**
 * Atomik's thinking on a new board, as "Start · up to N cr" shows it before its project exists: the
 * server's own planning figure (GET /api/workbench/team-canvas?agent=1&board=new, the same pricing a
 * saved empty project gets; it prices and nothing else). Read once Home is open, kept a minute.
 * What the answer means is lib/shell/thinking-price.ts.
 */
type Entry = { value: Thinking; at: number; reading: boolean };
const KEEP_MS = 60_000;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };
const tell = () => listeners.forEach((notify) => notify());
const LOADING: Thinking = { state: "loading" };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
async function read(fetcher: Fetcher): Promise<Thinking> {
  try {
    const response = await fetcher("/api/workbench/team-canvas?agent=1&board=new", { cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { state: "error", message: typeof body?.error === "string" ? body.error : THINKING_READ_FAILED };
    return thinkingFrom(body);
  } catch {
    return { state: "error", message: THINKING_READ_FAILED };
  }
}

export function useThinkingPrice(scope: string): { thinking: Thinking; retry: () => void } {
  const fetcher = useScopedFetch(scope);
  const thinking = useSyncExternalStore(subscribe, () => entries.get(scope)?.value ?? LOADING, () => LOADING);
  const load = useCallback((force: boolean) => {
    const known = entries.get(scope);
    if (known?.reading) return;
    if (!force && known && known.value.state !== "error" && Date.now() - known.at < KEEP_MS) return;
    entries.set(scope, { value: force ? LOADING : known?.value ?? LOADING, at: known?.at ?? 0, reading: true });
    if (force) tell();
    void read(fetcher).then((value) => { entries.set(scope, { value, at: Date.now(), reading: false }); tell(); });
  }, [scope, fetcher]);
  useEffect(() => { load(false); }, [load]);
  return { thinking, retry: () => load(true) };
}
