"use client";
import { useCallback, useSyncExternalStore } from "react";

const events = ["storage", "particl-paid-action-storage", "particl-composer-storage", "particl-generation-batch-storage"];
const subscribe = (listener: () => void) => {
  events.forEach(event => window.addEventListener(event, listener));
  return () => events.forEach(event => window.removeEventListener(event, listener));
};
const serverSnapshot = () => false;

/** Keep pre-project requests reachable until their original exact request settles. */
export function useLegacyRecovery(keys: string[], enabled: boolean) {
  const encoded = JSON.stringify(keys);
  const snapshot = useCallback(() => {
    if (!enabled) return false;
    try { return (JSON.parse(encoded) as string[]).some(key => localStorage.getItem(key) !== null); }
    // The original recovery reader reports corruption/storage failures and blocks spending.
    catch { return true; }
  }, [encoded, enabled]);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
