"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { mergePresets, type PresetItem } from "./image-ads";

/**
 * Marketing Studio Image's preset catalogue for the Image ads picker, through
 * the existing route (GET /api/higgsfield/marketing/presets: a free read on
 * Particl's API key, public preset metadata only). Read once the picker is
 * opened, again as the search changes (after a pause in typing), and a page
 * further on request by the cursor the last page ended on. A read that fails
 * says so with Try again; nothing is asked in a loop.
 */
export type PresetsState = {
  status: "idle" | "loading" | "ready" | "error";
  items: PresetItem[];
  cursor: string | null;
  more: "idle" | "loading" | "error";
  error: string | null;
};
const EMPTY: PresetsState = { status: "idle", items: [], cursor: null, more: "idle", error: null };
const ENDPOINT = "/api/higgsfield/marketing/presets";
export const SEARCH_PAUSE_MS = 400;
const UNREADABLE = "The presets could not be read.";

type Reply = { items?: PresetItem[]; cursor?: string | null; error?: string; code?: string } | null;

export function useMarketingPresets(scope: string, open: boolean) {
  const scoped = useScopedFetch();
  const [search, setSearch] = useState("");
  const [state, setState] = useState<PresetsState>(EMPTY);
  /* The search a reply answers: a reply for an older search is dropped. */
  const asked = useRef("");
  const read = useCallback(async (term: string, cursor: string | null): Promise<{ items: PresetItem[]; cursor: string | null }> => {
    const query = new URLSearchParams();
    if (term) query.set("search", term);
    if (cursor) query.set("cursor", cursor);
    const qs = query.toString();
    const response = await scoped(`${ENDPOINT}${qs ? `?${qs}` : ""}`, { cache: "no-store" });
    const json = await response.json().catch(() => null) as Reply;
    /* A search the route refuses says why (its length); anything else is a failed read. */
    if (!response.ok) throw new Error(response.status === 400 && json?.code === "invalid_search" && json.error ? json.error : UNREADABLE);
    return { items: Array.isArray(json?.items) ? json!.items : [], cursor: typeof json?.cursor === "string" ? json.cursor : null };
  }, [scoped]);

  const load = useCallback(async (term: string) => {
    asked.current = term;
    setState((prev) => ({ ...prev, status: "loading", error: null, more: "idle" }));
    try {
      const page = await read(term, null);
      if (asked.current !== term) return;
      setState({ status: "ready", items: page.items, cursor: page.cursor, more: "idle", error: null });
    } catch (error) {
      if (asked.current !== term) return;
      setState({ ...EMPTY, status: "error", error: error instanceof Error ? error.message : UNREADABLE });
    }
  }, [read]);

  const term = search.trim().slice(0, 100);
  useEffect(() => {
    if (!open || !scope) return;
    const timer = setTimeout(() => void load(term), term ? SEARCH_PAUSE_MS : 0);
    return () => clearTimeout(timer);
  }, [open, scope, term, load]);

  /** The next page of this search. */
  const more = useCallback(async () => {
    const cursor = state.cursor, forTerm = asked.current;
    if (!cursor || state.more === "loading") return;
    setState((prev) => ({ ...prev, more: "loading" }));
    try {
      const page = await read(forTerm, cursor);
      if (asked.current !== forTerm) return;
      setState((prev) => ({ ...prev, items: mergePresets(prev.items, page.items), cursor: page.cursor, more: "idle" }));
    } catch {
      if (asked.current !== forTerm) return;
      setState((prev) => ({ ...prev, more: "error" }));
    }
  }, [read, state.cursor, state.more]);

  return { search, setSearch, state, more, retry: () => void load(term) };
}
