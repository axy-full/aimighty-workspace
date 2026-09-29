/**
 * The words for the platform's shared provider key, for the server and the
 * browser alike (nothing here reaches a database, a key or the network).
 * lib/providerPool.ts is the pool; lib/higgsfieldKeyAlerts.ts the changed key.
 */

/** What a held take carries (`params.held.pool`) while it waits for the shared pool. Never a vendor name. */
export const POOL_MARK = "shared";
/** Said when Generate parks a take behind a full pool. */
export const POOL_QUEUED = "Queued — starts when a slot frees.";
/** The same wait, as one line under a "Queued" label (the jobs tray, Takes). */
export const POOL_REASON = "Starts when a slot frees";

/** A take whose provider key is gone waits with these words, and is never failed or sent again for it. */
export const KEY_CHANGED = "The provider key changed; checking with the provider.";
/** Its label in the jobs tray, and its one line (the words without the full stop). */
export const KEY_CHANGED_LABEL = "Checking";
export const KEY_CHANGED_REASON = KEY_CHANGED.replace(/\.$/, "");

/** Whether a stored take is waiting on a changed key (`params.providerKeyChanged`: since when). */
export const waitsOnChangedKey = (params: Record<string, unknown> | null | undefined): boolean =>
  typeof params?.providerKeyChanged === "number" && params.providerKeyChanged > 0;
