"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { libraryEntries, type LibraryEntry } from "@/lib/workspace/library";
import type { LibraryUpload } from "@/lib/genLibrary";
import type { Generation } from "@/lib/jobs";
import { readTrayParams, writeTrayParams, type TrayKind, type TrayParams, type TraySource } from "./library";

/**
 * The tray's open state, source and kind: read from the address once (`drawer=Library`, `lib=1`, `src=`, `libkind=`),
 * then kept here and mirrored back into the address (replace, never a new history entry). The shell's own moves may
 * drop the mirror; the tray stays as it was.
 */
export function useTrayState() {
  const [state, setState] = useState<TrayParams>(() => (typeof window === "undefined" ? { open: false, source: "All", kind: "All" } : readTrayParams(window.location.search)));
  useEffect(() => {
    const next = writeTrayParams(window.location.search, state);
    if (next !== window.location.search) window.history.replaceState(window.history.state, "", `${window.location.pathname}${next}${window.location.hash}`);
  }, [state]);
  const setOpen = useCallback((open: boolean | ((was: boolean) => boolean)) => setState((s) => ({ ...s, open: typeof open === "function" ? open(s.open) : open })), []);
  const setSource = useCallback((source: TraySource) => setState((s) => ({ ...s, source })), []);
  const setKind = useCallback((kind: TrayKind) => setState((s) => ({ ...s, kind })), []);
  return { ...state, setOpen, setSource, setKind };
}

export type TrayRead = { status: "loading" | "ready" | "error"; entries: LibraryEntry[]; error: string | null; retry: () => void };

const READ_FAILED = "The Library could not be read.";

/**
 * One board's library, as the tray shows it. With no search on the open board it is the shell's own copy (`own`, the
 * store every screen shares). A search, or another board's library, is read from GET /api/workbench/library with the
 * route's own `q`: the server searches this workspace's database, within that board's filing. Nothing is searched here.
 */
export function useTrayLibrary(projectId: string | null, query: string, own: { projectId: string | null; entries: readonly LibraryEntry[]; status: string; error: string | null; retry: () => void }): TrayRead {
  const fetcher = useScopedFetch();
  const q = query.trim();
  const useOwn = !q && projectId === own.projectId;
  const key = !useOwn && projectId ? JSON.stringify([projectId, q]) : null;
  const [answer, setAnswer] = useState<{ key: string; read: Omit<TrayRead, "retry"> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key || !projectId) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const page = async (source: "uploads" | "generations") => {
        const params = new URLSearchParams({ projectId, source, limit: "60" });
        if (q) params.set("q", q);
        const response = await fetcher(`/api/workbench/library?${params}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(body?.[source])) throw new Error(typeof body?.error === "string" ? body.error : READ_FAILED);
        return body[source] as unknown[];
      };
      try {
        const [uploads, generations] = await Promise.all([page("uploads"), page("generations")]);
        if (controller.signal.aborted) return;
        setAnswer({ key, read: { status: "ready", entries: libraryEntries({ uploads: uploads as LibraryUpload[], generations: generations as Generation[] }), error: null } });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setAnswer({ key, read: { status: "error", entries: [], error: cause instanceof Error && cause.message ? cause.message : READ_FAILED } });
      }
    }, q ? 250 : 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, projectId, q, fetcher, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return useMemo<TrayRead>(() => {
    /* No board open (Home, or a person with no boards yet): nothing to read, so an empty Library, never "Reading…". */
    if (!projectId) return { status: "ready", entries: [], error: null, retry };
    if (useOwn) {
      const status = own.status === "error" && !own.entries.length ? "error" : own.status === "ready" || own.entries.length ? "ready" : "loading";
      return { status, entries: [...own.entries], error: own.error, retry: own.retry };
    }
    if (!key) return { status: "ready", entries: [], error: null, retry };
    return answer?.key === key ? { ...answer.read, retry } : { status: "loading", entries: [], error: null, retry };
  }, [projectId, useOwn, own.status, own.entries, own.error, own.retry, key, answer, retry]);
}

/** Whether a key press belongs to a field (the tray's L never fires while typing). */
export function inField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}
