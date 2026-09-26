"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONNECTED_GENERATION_ENDPOINT } from "@/lib/higgsfield-consumer/generation-client";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ADS_MODEL, IMAGE_ADS_MODEL, SETUP_TYPES, type SetupItem, type SetupType, DTC_ADS_MODEL, catalogueBlock, retryAfterMs, AUTO_RETRIES, type CatalogueStatus } from "./business";

/**
 * What the Business pages read before they can compose (FINAL_SPEC §2):
 * whether the connected account is connected, the live catalogue entries for
 * Marketing Studio (their ranges and roles drive the chips — never a
 * hard-coded list), and the account's setup items by type.
 */
export type CatalogueModel = { id: string; name: string; outputType: string; aspectRatios?: string[]; durations?: number[]; durationRange?: { min: number; max: number }; medias?: { name: string; roles: string[]; max?: number }[]; parameters?: { name: string; options?: (string | number)[]; min?: number; max?: number }[] };
export type SetupState = { connected: boolean | null; reads: Partial<Record<SetupType, { available: boolean; items: SetupItem[] }>>; loading: boolean; error: string | null };

export function useBusiness(scopeReady: boolean) {
  const scoped = useScopedFetch();
  const [connection, setConnection] = useState<{ owner: boolean; connected: boolean } | null>(null);
  const [models, setModels] = useState<Record<string, CatalogueModel>>({});
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [catalogueStatus, setCatalogueStatus] = useState<CatalogueStatus>("idle");
  /* Failed reads so far; each one schedules the next read a little later. */
  const [catalogueFailures, setCatalogueFailures] = useState(0);
  const [setup, setSetup] = useState<SetupState>({ connected: null, reads: {}, loading: false, error: null });

  useEffect(() => {
    if (!scopeReady) return;
    let live = true;
    (async () => {
      try {
        const me = await scoped("/api/me", { cache: "no-store" }).then((r) => r.json()) as { owner?: boolean };
        const connection = me.owner === true
          ? await scoped("/api/higgsfield/consumer/connection", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { connected: false })) as { connected?: boolean; requiresReconnect?: boolean }
          : { connected: false };
        if (live) setConnection({ owner: me.owner === true, connected: connection.connected === true && connection.requiresReconnect !== true });
      } catch { if (live) setConnection({ owner: false, connected: false }); }
    })();
    return () => { live = false; };
  }, [scoped, scopeReady]);

  /* The two Marketing Studio entries, from the live catalogue. A failed read is tried again a few times, further
     apart each time; after that only Read again (readCatalogue) asks the account. */
  const connected = connection?.connected ?? false;
  useEffect(() => {
    if (!connected || catalogueFailures > AUTO_RETRIES) return;
    let live = true;
    const timer = setTimeout(() => void (async () => {
      try {
        const found: Record<string, CatalogueModel> = {};
        for (const type of ["video", "image"] as const) {
          const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "catalogue", type }) });
          const json = await response.json().catch(() => null) as { catalogue?: { models?: CatalogueModel[] }; error?: string } | null;
          if (!response.ok) throw new Error(json?.error ?? "The connected catalogue could not be read.");
          for (const m of json?.catalogue?.models ?? []) if (m.id === ADS_MODEL || m.id === IMAGE_ADS_MODEL || m.id === DTC_ADS_MODEL) found[m.id] = m;
        }
        if (live) { setModels(found); setCatalogueError(null); setCatalogueStatus("ready"); }
      } catch (error) {
        if (!live) return;
        setCatalogueError(error instanceof Error ? error.message : "The connected catalogue could not be read.");
        setCatalogueStatus("error");
        setCatalogueFailures((n) => n + 1);
      }
    })(), catalogueFailures ? retryAfterMs(catalogueFailures) : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [scoped, connected, catalogueFailures]);

  const catalogueStalled = catalogueStatus === "error" && catalogueFailures > AUTO_RETRIES;
  const readCatalogue = useCallback(() => setCatalogueFailures(0), []);

  /** Why a composer cannot use this catalogue model yet (null when it can). */
  const modelBlock = useCallback((model: string) => catalogueBlock({ connected, status: catalogueStatus, error: catalogueError, offered: Boolean(models[model]), model }), [connected, catalogueStatus, catalogueError, models]);

  /* One read at a time: a page that asks while a read is in flight is answered by that read. After a
     failure the pages do not ask again on their own (that looped against the account); Read again does. */
  const reading = useRef(false);
  const readSetup = useCallback(async (types?: SetupType[]) => {
    if (reading.current) return;
    reading.current = true;
    setSetup((s) => ({ ...s, loading: true, error: null }));
    try {
      const response = await scoped("/api/higgsfield/consumer/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "setup", ...(types ? { types } : {}) }) });
      const json = await response.json().catch(() => null) as { connected?: boolean; reads?: { type: SetupType; available: boolean; items: SetupItem[] }[]; error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The setup items could not be read.");
      setSetup((s) => ({ connected: json?.connected ?? false, loading: false, error: null, reads: { ...s.reads, ...Object.fromEntries((json?.reads ?? []).map((r) => [r.type, { available: r.available, items: r.items }])) } }));
    } catch (error) {
      setSetup((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : "The setup items could not be read." }));
    } finally { reading.current = false; }
  }, [scoped]);

  return { connection, models, catalogueError, catalogueStalled, readCatalogue, modelBlock, setup, readSetup, setupTypes: SETUP_TYPES };
}
