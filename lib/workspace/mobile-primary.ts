"use client";
import { useEffect, useSyncExternalStore } from "react";
import type { PageId } from "./types";

/**
 * The pinned primary a mounted phone page owns.
 *
 * Most pages need nothing here: the action bar derives their primary from
 * `primaryAction` and the page's plan. A page whose primary carries a LIVE
 * figure that only the page body holds — the Form template's connected-account
 * quote — publishes it instead, the same way a spec page publishes its facts to
 * the Inspector (lib/workspace/spec-store.ts). One primary, one place, so the
 * button and the page can never disagree about the price or about what blocks
 * it.
 *
 * The shape is MobileActionBar's `MobilePrimary`; it is written structurally
 * here so the state layer never imports a component.
 */

export type PublishedPrimary = {
  label: string;
  /** The exact live cost, shown inline on the button. Null when there is none. */
  cost: string | null;
  /** Why it cannot run. The button stays visible and says so. */
  blocked: string | null;
  run: () => void;
};

type Published = { page: PageId; primary: PublishedPrimary } | null;

let published: Published = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

export function publishMobilePrimary(page: PageId, primary: PublishedPrimary) {
  published = { page, primary };
  emit();
}

export function clearMobilePrimary(page: PageId) {
  if (published?.page !== page) return;
  published = null;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => published;
const serverSnapshot = (): Published => null;

/** The primary the mounted page published for `page`, or null before it has. */
export function useMobilePrimary(page: PageId): PublishedPrimary | null {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return value?.page === page ? value.primary : null;
}

/**
 * For a page body: publish this render's primary and withdraw it on unmount.
 * `null` withdraws it too, so a page that cannot offer one falls back to the
 * action bar's own derivation rather than pinning a stale button.
 */
export function usePublishPrimary(page: PageId, primary: PublishedPrimary | null) {
  useEffect(() => {
    if (primary) publishMobilePrimary(page, primary);
    else clearMobilePrimary(page);
    return () => clearMobilePrimary(page);
  }, [page, primary]);
}
