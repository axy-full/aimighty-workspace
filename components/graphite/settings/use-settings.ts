"use client";
import { useCallback, useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";

/** Settings' reads: one route each, scoped to the workspace; a refusal comes back as the sentence to show. */
export function useRead<T>(url: string | null) {
  const scoped = useScopedFetch();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    if (!url) return;
    try {
      const response = await scoped(url, { cache: "no-store" });
      const json = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
      if (!response.ok || !json) throw new Error(json?.error ?? "This could not be read.");
      setData(json);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "This could not be read.");
    }
  }, [scoped, url]);
  useEffect(() => {
    const t = setTimeout(() => void read(), 0);
    return () => clearTimeout(t);
  }, [read]);
  return { data, error, read };
}

/** One write to an existing route; the route's own refusal comes back as the sentence to show. */
export function useWrite() {
  const scoped = useScopedFetch();
  return useCallback(async <T,>(url: string, method: string, body?: unknown): Promise<{ json: T | null; error: string | null }> => {
    try {
      const response = await scoped(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
      return response.ok ? { json, error: null } : { json: null, error: json?.error ?? "That change could not be made." };
    } catch (caught) {
      return { json: null, error: caught instanceof Error && caught.message ? caught.message : "That change could not be made." };
    }
  }, [scoped]);
}

/** A dropped connection, as fetch words it in each browser. */
export const lostConnection = (text: string) => /fetch|network|load failed/i.test(text);
