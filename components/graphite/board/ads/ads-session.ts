"use client";
import { useMemo, useSyncExternalStore } from "react";
import type { BrandExtraction } from "@/lib/workbench/brand-extraction-types";
import type { ProductExtraction } from "@/lib/workbench/product-extraction-types";
import type { ReferenceAdAnalysis } from "@/lib/workbench/reference-ad-analysis";

/*
 * What the Ads board holds for this tab and this project, never saved: a read of a site waiting for a person's
 * review (nothing from a page is used until it is reviewed), the hooks picked to ride with the next brief sent to
 * Make (lasts for the session, no new field: decision 32), what the Campaign agent is doing, and which panel or
 * screen is open over the board. One small external store per project, so the cards (pure derive) and the overlay
 * (panels, dialogs, the Designer) read the same facts.
 */
export type SiteRead<T> = { url: string; status: "reading" | "ready" | "failed"; error?: string; result?: T };
export type PanelId = "brand" | "product" | "reference" | "hooks" | "formats";
export type DialogId = "hooks" | "reference";

/** The agent's runs for this project, reduced to the plain facts the cards show (the full list stays with the overlay). */
export type AgentSnap = {
  ready: boolean;
  configured: boolean;
  /** The Campaign agent is writing hooks, or a reference review is running. */
  hooksRunning: boolean;
  referenceRunning: boolean;
  /** Every line the agent's runs proposed, newest run first (the cards drop those already on the list). */
  proposed: readonly string[];
  /** The newest review of the chosen reference video, when there is one. */
  analysis: ReferenceAdAnalysis | null;
  error: string | null;
};

export type AdsSession = {
  brand: SiteRead<BrandExtraction> | null;
  product: SiteRead<ProductExtraction> | null;
  picked: readonly string[];
  agent: AgentSnap | null;
  panel: PanelId | null;
  dialog: DialogId | null;
  designer: boolean;
};
export const EMPTY_SESSION: AdsSession = { brand: null, product: null, picked: [], agent: null, panel: null, dialog: null, designer: false };

const sessions = new Map<string, AdsSession>();
const listeners = new Set<() => void>();
const key = (projectId: string | null | undefined) => projectId ?? "";

export function readSession(projectId: string | null | undefined): AdsSession {
  return sessions.get(key(projectId)) ?? EMPTY_SESSION;
}
export function patchSession(projectId: string | null | undefined, patch: Partial<AdsSession> | ((now: AdsSession) => Partial<AdsSession>)) {
  const now = readSession(projectId);
  const next = { ...now, ...(typeof patch === "function" ? patch(now) : patch) };
  sessions.set(key(projectId), next);
  listeners.forEach((fn) => fn());
}
export function clearSession(projectId: string | null | undefined) {
  sessions.delete(key(projectId));
  listeners.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function useAdsSession(projectId: string | null | undefined): AdsSession {
  return useSyncExternalStore(subscribe, () => readSession(projectId), () => EMPTY_SESSION);
}

/** What the cards derive from: the session without its panels and dialogs, so opening a panel redraws nothing. */
export type AdsExtra = Pick<AdsSession, "brand" | "product" | "picked" | "agent">;
export const EMPTY_EXTRA: AdsExtra = { brand: null, product: null, picked: [], agent: null };

export function useAdsExtra(projectId: string | null | undefined, active: boolean): AdsExtra | null {
  const s = useAdsSession(projectId);
  return useMemo(() => (active ? { brand: s.brand, product: s.product, picked: s.picked, agent: s.agent } : null), [active, s.brand, s.product, s.picked, s.agent]);
}

export const openPanel = (projectId: string | null | undefined, panel: PanelId | null) => patchSession(projectId, { panel });
export const openDialog = (projectId: string | null | undefined, dialog: DialogId | null) => patchSession(projectId, { dialog });
export const openDesigner = (projectId: string | null | undefined, designer: boolean) => patchSession(projectId, { designer });
export function togglePicked(projectId: string | null | undefined, hook: string) {
  patchSession(projectId, (s) => ({ picked: s.picked.includes(hook) ? s.picked.filter((h) => h !== hook) : [...s.picked, hook] }));
}
