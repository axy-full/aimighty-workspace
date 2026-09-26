"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CONNECTED_GENERATION_ENDPOINT } from "@/lib/higgsfield-consumer/generation-client";
import { presentTimeout, retryDelay } from "@/lib/poll";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ADS_MODEL, IMAGE_ADS_MODEL, SETUP_TYPES, type SetupItem, type SetupType, DTC_ADS_MODEL } from "./business";

/**
 * What the Business pages read before they can compose (FINAL_SPEC §2):
 * whether the connected account is connected, the live catalogue entries for
 * Marketing Studio (their ranges and roles drive the chips — never a
 * hard-coded list), and the account's setup items by type.
 *
 * A read that fails keeps its error on screen and is tried again on its own
 * after about 2 s, 6 s and 18 s (lib/poll's `retryDelay`; never while the tab
 * is hidden or offline); after that only Try again reads it. Nothing is ever
 * read in a loop.
 */
export type CatalogueModel = { id: string; name: string; outputType: string; aspectRatios?: string[]; durations?: number[]; durationRange?: { min: number; max: number }; medias?: { name: string; roles: string[]; max?: number }[]; parameters?: { name: string; options?: (string | number)[]; min?: number; max?: number }[] };
export type SetupState = { connected: boolean | null; reads: Partial<Record<SetupType, { available: boolean; items: SetupItem[] }>>; loading: boolean; error: string | null };

/** Said when a read's reply names nothing to do: the route's own fallback is about a saved job, and a read has none. */
export const READ_FAILED = "The connected account did not answer.";
/**
 * A failed read in the product's words: the route's reason when it names one (a reconnect, a limit, a
 * refused request), else that the account did not answer — a dropped connection or any 5xx without a code.
 */
export function readFailure(status: number | null, json: { error?: unknown; code?: unknown } | null): string {
  const said = typeof json?.error === "string" ? json.error.trim() : "";
  if (!said || status === null) return READ_FAILED;
  return status >= 500 && typeof json?.code !== "string" ? READ_FAILED : said;
}
const failureOf = (error: unknown) => (error instanceof Error && error.name === "ReadFailure" ? error.message : READ_FAILED);
const readError = (status: number, json: { error?: unknown; code?: unknown } | null) => Object.assign(new Error(readFailure(status, json)), { name: "ReadFailure" });

export function useBusiness(scopeReady: boolean) {
  const scoped = useScopedFetch();
  const [connection, setConnection] = useState<{ owner: boolean; connected: boolean } | null>(null);
  const [models, setModels] = useState<Record<string, CatalogueModel>>({});
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  /** A catalogue read has landed (so a missing model is missing, not still being read). */
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
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
    /* Not connected: nothing is read, and a reconnect starts the automatic retries afresh. */
    if (!connection?.connected) { catalogueMisses.current = 0; return; }
    let live = true;
    let cancelRetry: (() => void) | undefined;
    (async () => {
      try {
        const found: Record<string, CatalogueModel> = {};
        for (const type of ["video", "image"] as const) {
          const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "catalogue", type }) });
          const json = await response.json().catch(() => null) as { catalogue?: { models?: CatalogueModel[] }; error?: string; code?: string } | null;
          if (!response.ok) throw readError(response.status, json);
          for (const m of json?.catalogue?.models ?? []) if (m.id === ADS_MODEL || m.id === IMAGE_ADS_MODEL || m.id === DTC_ADS_MODEL) found[m.id] = m;
        }
        if (!live) return;
        catalogueMisses.current = 0;
        setModels(found); setCatalogueError(null); setCatalogueLoaded(true);
      } catch (error) {
        if (!live) return;
        setCatalogueError(failureOf(error));
        const wait = retryDelay(++catalogueMisses.current);
        if (wait !== null) cancelRetry = presentTimeout(() => setCatalogueTurn((t) => ({ n: t.n + 1, reading: true })), wait);
      } finally {
        if (live) setCatalogueTurn((t) => (t.reading ? { ...t, reading: false } : t));
      }
    })();
    return () => { live = false; cancelRetry?.(); };
  }, [scoped, connection?.connected, catalogueN]);
  /** Read the catalogue again now. */
  const retryCatalogue = useCallback(() => setCatalogueTurn((t) => (t.reading ? t : { n: t.n + 1, reading: true })), []);
  /* Nothing is read while the account is not connected: no read is out, and its old error is not offered for a Try again. */
  const catalogueLive = connection?.connected === true;

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
      const json = await response.json().catch(() => null) as { connected?: boolean; reads?: { type: SetupType; available: boolean; items: SetupItem[] }[]; error?: string; code?: string } | null;
      if (!response.ok) throw readError(response.status, json);
      setupMisses.current = 0;
      setSetup((s) => ({ connected: json?.connected ?? false, loading: false, error: null, reads: { ...s.reads, ...Object.fromEntries((json?.reads ?? []).map((r) => [r.type, { available: r.available, items: r.items }])) } }));
    } catch (error) {
      const n = ++setupMisses.current, wait = retryDelay(n);
      setSetup((s) => ({ ...s, loading: false, error: failureOf(error) }));
      if (wait !== null) setSetupRetry({ types, wait, n });
    } finally { reading.current = false; }
  }, [scoped]);
  /* The automatic retry of a failed setup read, held while the tab is hidden or offline; Try again (or leaving the page) cancels it. */
  useEffect(() => {
    if (!setupRetry) return;
    return presentTimeout(() => void readSetup(setupRetry.types), setupRetry.wait);
  }, [setupRetry, readSetup]);

  return {
    connection, models, setup, readSetup, setupTypes: SETUP_TYPES, retryCatalogue,
    catalogueError: catalogueLive ? catalogueError : null,
    catalogueReading: catalogueLive && catalogueTurn.reading,
    catalogueLoaded: catalogueLive && catalogueLoaded,
  };
}
