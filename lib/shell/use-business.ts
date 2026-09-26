"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONNECTED_GENERATION_ENDPOINT } from "@/lib/higgsfield-consumer/generation-client";
import { retryDelay } from "@/lib/poll";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ADS_MODEL, IMAGE_ADS_MODEL, SETUP_TYPES, type SetupItem, type SetupType, DTC_ADS_MODEL } from "./business";

/**
 * What the Business pages read before they can compose (FINAL_SPEC §2):
 * whether the connected account is connected, the live catalogue entries for
 * Marketing Studio (their ranges and roles drive the chips — never a
 * hard-coded list), and the account's setup items by type.
 *
 * A read that fails keeps its error on screen and is tried again on its own
 * after about 2 s, 6 s and 18 s (lib/poll's `retryDelay`); after that only
 * Try again reads it. Nothing is ever read in a loop.
 */
export type CatalogueModel = { id: string; name: string; outputType: string; aspectRatios?: string[]; durations?: number[]; durationRange?: { min: number; max: number }; medias?: { name: string; roles: string[]; max?: number }[]; parameters?: { name: string; options?: (string | number)[]; min?: number; max?: number }[] };
export type SetupState = { connected: boolean | null; reads: Partial<Record<SetupType, { available: boolean; items: SetupItem[] }>>; loading: boolean; error: string | null };

export function useBusiness(scopeReady: boolean) {
  const scoped = useScopedFetch();
  const [connection, setConnection] = useState<{ owner: boolean; connected: boolean } | null>(null);
  const [models, setModels] = useState<Record<string, CatalogueModel>>({});
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  /** Bumped to read the catalogue again (Try again, or an automatic retry); `reading` while that read is out. */
  const [catalogueTurn, setCatalogueTurn] = useState({ n: 0, reading: false });
  const catalogueMisses = useRef(0);
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

  /* The two Marketing Studio entries, from the live catalogue. */
  const catalogueN = catalogueTurn.n;
  useEffect(() => {
    if (!connection?.connected) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      try {
        const found: Record<string, CatalogueModel> = {};
        for (const type of ["video", "image"] as const) {
          const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "catalogue", type }) });
          const json = await response.json().catch(() => null) as { catalogue?: { models?: CatalogueModel[] }; error?: string } | null;
          if (!response.ok) throw new Error(json?.error ?? "The connected catalogue could not be read.");
          for (const m of json?.catalogue?.models ?? []) if (m.id === ADS_MODEL || m.id === IMAGE_ADS_MODEL || m.id === DTC_ADS_MODEL) found[m.id] = m;
        }
        if (!live) return;
        catalogueMisses.current = 0;
        setModels(found); setCatalogueError(null);
      } catch (error) {
        if (!live) return;
        setCatalogueError(error instanceof Error ? error.message : "The connected catalogue could not be read.");
        const wait = retryDelay(++catalogueMisses.current);
        if (wait !== null) timer = setTimeout(() => setCatalogueTurn((t) => ({ n: t.n + 1, reading: true })), wait);
      } finally {
        if (live) setCatalogueTurn((t) => (t.reading ? { ...t, reading: false } : t));
      }
    })();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [scoped, connection?.connected, catalogueN]);
  /** Read the catalogue again now. */
  const retryCatalogue = useCallback(() => setCatalogueTurn((t) => (t.reading ? t : { n: t.n + 1, reading: true })), []);

  /* One read at a time: a page that asks while a read is in flight waits for it. A failed read keeps
     its error while it is tried again, so the alert does not flicker; a good read clears it. */
  const reading = useRef(false);
  const setupMisses = useRef(0);
  const [setupRetry, setSetupRetry] = useState<{ types?: SetupType[]; wait: number; n: number } | null>(null);
  const readSetup = useCallback(async (types?: SetupType[]) => {
    if (reading.current) return;
    reading.current = true;
    setSetupRetry(null);
    setSetup((s) => ({ ...s, loading: true }));
    try {
      const response = await scoped("/api/higgsfield/consumer/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "setup", ...(types ? { types } : {}) }) });
      const json = await response.json().catch(() => null) as { connected?: boolean; reads?: { type: SetupType; available: boolean; items: SetupItem[] }[]; error?: string } | null;
      if (!response.ok) throw new Error(json?.error ?? "The setup items could not be read.");
      setupMisses.current = 0;
      setSetup((s) => ({ connected: json?.connected ?? false, loading: false, error: null, reads: { ...s.reads, ...Object.fromEntries((json?.reads ?? []).map((r) => [r.type, { available: r.available, items: r.items }])) } }));
    } catch (error) {
      const n = ++setupMisses.current, wait = retryDelay(n);
      setSetup((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : "The setup items could not be read." }));
      if (wait !== null) setSetupRetry({ types, wait, n });
    } finally { reading.current = false; }
  }, [scoped]);
  /* The automatic retry of a failed setup read; Try again (or leaving the page) cancels it. */
  useEffect(() => {
    if (!setupRetry) return;
    const timer = setTimeout(() => void readSetup(setupRetry.types), setupRetry.wait);
    return () => clearTimeout(timer);
  }, [setupRetry, readSetup]);

  return { connection, models, catalogueError, catalogueReading: catalogueTurn.reading, retryCatalogue, setup, readSetup, setupTypes: SETUP_TYPES };
}
