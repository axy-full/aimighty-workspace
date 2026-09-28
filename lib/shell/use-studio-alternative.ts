"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { activeModel, workspaceModels, type ComposerModel, type EngineRow } from "@/lib/workspace/composer";
import { rateQuery, rowPrice, type PriceAt, type RowPrice } from "@/lib/workspace/model-picker";

/**
 * What a member's owner-run card offers instead (idea 19): the Studio engine
 * Gen opens on for that output, priced exactly as Gen's model sheet prices it
 * — the engines route's list read at the project's aspect and Gen's untouched
 * settings (lib/workspace/model-picker › rowPrice), in this workspace's
 * credits. One free read per scope and aspect a minute, shared by every card;
 * nothing is quoted, reserved or sent.
 */
export type StudioAlternative = {
  status: "loading" | "ready" | "error";
  /** The engine Gen opens on for this output: the composer's own default (lib/workspace/composer › activeModel). */
  model: Pick<ComposerModel, "id" | "label"> | null;
  price: RowPrice | null;
  retry: () => void;
};

const FRESH_MS = 60_000;
const UNREADABLE = "The price could not be read.";
const lists = new Map<string, { at: number; rows: EngineRow[] }>();
const reading = new Map<string, Promise<EngineRow[]>>();

function priceAt(aspect: string | null | undefined): PriceAt {
  return { ...(aspect ? { aspect } : {}), picks: {}, references: [], seconds: 10, takes: 1 };
}

async function readList(scope: string, query: string): Promise<EngineRow[]> {
  const key = `${scope}?${query}`;
  const kept = lists.get(key);
  if (kept && Date.now() - kept.at < FRESH_MS) return kept.rows;
  const running = reading.get(key);
  if (running) return running;
  const job = fetch(`/api/workbench/engines?${query}`, { headers: { "X-Workbench-Scope": scope }, cache: "no-store" })
    .then(async (response) => {
      const json = await response.json().catch(() => null) as { models?: EngineRow[] } | null;
      if (!response.ok || !Array.isArray(json?.models)) throw new Error(UNREADABLE);
      lists.set(key, { at: Date.now(), rows: json.models });
      return json.models;
    })
    .finally(() => { reading.delete(key); });
  reading.set(key, job);
  return job;
}

export function useStudioAlternative(scope: string | null | undefined, type: "image" | "video" | null, aspect?: string | null): StudioAlternative {
  const at = useMemo(() => priceAt(aspect), [aspect]);
  const query = useMemo(() => rateQuery(at), [at]);
  const key = scope && type ? `${scope}?${query}` : null;
  const [answer, setAnswer] = useState<{ key: string; rows: EngineRow[] | null; failed: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!scope || !type || !key) return;
    let live = true;
    readList(scope, query)
      .then((rows) => { if (live) setAnswer({ key, rows, failed: false }); })
      .catch(() => { if (live) setAnswer({ key, rows: null, failed: true }); });
    return () => { live = false; };
  }, [scope, type, key, query, attempt]);
  const retry = useCallback(() => { setAnswer(null); setAttempt((n) => n + 1); }, []);
  return useMemo(() => {
    const mine = answer && answer.key === key ? answer : null;
    if (!type || !mine) return { status: "loading", model: null, price: null, retry };
    if (mine.failed || !mine.rows) return { status: "error", model: null, price: null, retry };
    const model = activeModel({ type, billing: "workspace", chosen: {} }, workspaceModels(mine.rows, null));
    return { status: "ready", model: model ? { id: model.id, label: model.label } : null, price: model ? rowPrice(model, {}, at) : null, retry };
  }, [answer, key, type, at, retry]);
}
