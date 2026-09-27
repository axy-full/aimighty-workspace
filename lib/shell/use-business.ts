"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONNECTED_GENERATION_ENDPOINT } from "@/lib/higgsfield-consumer/generation-client";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { ADS_MODEL, IMAGE_ADS_MODEL, SETUP_TYPES, type SetupItem, type SetupType, DTC_ADS_MODEL } from "./business";
import { useConnectedCapability } from "./use-connected-capability";

/**
 * What the Business pages read before they can compose (FINAL_SPEC §2):
 * whether the connected account is connected (the shell's one shared answer,
 * lib/shell/use-connected-capability — a member is known from the session and
 * nothing is read for them), the live catalogue entries for Marketing Studio
 * (their ranges and roles drive the chips — never a hard-coded list), and the
 * account's setup items by type.
 */
export type CatalogueModel = { id: string; name: string; outputType: string; aspectRatios?: string[]; durations?: number[]; durationRange?: { min: number; max: number }; medias?: { name: string; roles: string[]; max?: number }[]; parameters?: { name: string; options?: (string | number)[]; min?: number; max?: number }[] };
export type SetupState = { connected: boolean | null; reads: Partial<Record<SetupType, { available: boolean; items: SetupItem[] }>>; loading: boolean; error: string | null };

export function useBusiness(scope: string) {
  const scoped = useScopedFetch();
  const capability = useConnectedCapability(scope || null, { read: Boolean(scope) });
  /* Null until the owner's connection is read; a failed read is the owner's error to retry, never a demotion to member. */
  const connection = useMemo(() => (capability.status === "loading" ? null : { owner: capability.owner, connected: capability.connected, reconnect: capability.reconnect }), [capability.status, capability.owner, capability.connected, capability.reconnect]);
  const connectionError = capability.status === "error" ? capability.error : null;
  const [models, setModels] = useState<Record<string, CatalogueModel>>({});
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupState>({ connected: null, reads: {}, loading: false, error: null });

  /* The two Marketing Studio entries, from the live catalogue. */
  useEffect(() => {
    if (!connection?.connected) return;
    let live = true;
    (async () => {
      try {
        const found: Record<string, CatalogueModel> = {};
        for (const type of ["video", "image"] as const) {
          const response = await scoped(CONNECTED_GENERATION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "catalogue", type }) });
          const json = await response.json().catch(() => null) as { catalogue?: { models?: CatalogueModel[] }; error?: string } | null;
          if (!response.ok) throw new Error(json?.error ?? "The connected catalogue could not be read.");
          for (const m of json?.catalogue?.models ?? []) if (m.id === ADS_MODEL || m.id === IMAGE_ADS_MODEL || m.id === DTC_ADS_MODEL) found[m.id] = m;
        }
        if (live) { setModels(found); setCatalogueError(null); }
      } catch (error) { if (live) setCatalogueError(error instanceof Error ? error.message : "The connected catalogue could not be read."); }
    })();
    return () => { live = false; };
  }, [scoped, connection?.connected]);

  /* One read at a time: a page that asks while a read is in flight waits for it. */
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

  return { connection, connectionError, refreshConnection: capability.refresh, models, catalogueError, setup, readSetup, setupTypes: SETUP_TYPES };
}
