"use client";
import { useEffect, useState } from "react";
import { studioRequest } from "@/components/workbench/GenerationDialog";
import { quoteRecreate, type QuoteReader, type RecreatePrice } from "./recreate-price";
import type { RecipeSource } from "./recipe";

const FRESH_MS = 60_000;
const seen = new Map<string, { at: number; price: RecreatePrice }>();

/**
 * The price of recreating the take whose right-click menu is open (lib/shell/recreate-price.ts): read once when the menu opens, kept
 * for a minute (the server's quote is free to ask but not free to ask on every hover). `source` null: no menu, or no take; nothing is asked.
 * A figure that could not be read is never kept, so the next opening asks again.
 */
export function useRecreatePrice(scope: string, id: string | null, source: RecipeSource | null, aspect?: string): RecreatePrice | null {
  const key = id && source ? `${scope}:${id}` : null;
  const [answer, setAnswer] = useState<{ key: string; price: RecreatePrice } | null>(null);
  useEffect(() => {
    if (!key || !source) return;
    const kept = seen.get(key);
    if (kept && Date.now() - kept.at < FRESH_MS) { setAnswer({ key, price: kept.price }); return; }
    let live = true;
    const read: QuoteReader = (url, init) => studioRequest<unknown>(url, {
      cache: "no-store",
      headers: { "X-Workbench-Scope": scope, ...(init ? { "Content-Type": "application/json" } : {}) },
      ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {}),
    });
    void quoteRecreate(source, read, { aspect }).then((price) => {
      if (price.state === "ready") seen.set(key, { at: Date.now(), price });
      if (live) setAnswer({ key, price });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scope]);
  if (!key) return null;
  return answer?.key === key ? answer.price : { state: "reading" };
}
