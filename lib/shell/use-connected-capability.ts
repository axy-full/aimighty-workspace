"use client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";
import {
  CAPABILITY_UNREADABLE, CONNECTION_ENDPOINT, capabilityOf, createCapabilityStore,
  type ConnectedCapability, type ConnectionReply,
} from "./connected-capability";

/** The page's one set of answers: every surface reads through it, so the account is read once per scope. */
const store = createCapabilityStore(async (scope) => {
  const response = await fetch(CONNECTION_ENDPOINT, { headers: { "X-Workbench-Scope": scope }, cache: "no-store" });
  const json = await response.json().catch(() => null) as (ConnectionReply & { error?: unknown }) | null;
  if (!response.ok) throw new Error(typeof json?.error === "string" && json.error ? json.error : CAPABILITY_UNREADABLE);
  return json;
});

/**
 * Who runs the connected account here, and whether it answers
 * (lib/shell/connected-capability.ts). Whether this person is the owner — and,
 * for a member, the owner's name — comes from the server-rendered session (the
 * shell's own /api/me answer, lib/session), so a member's surfaces render their
 * card on the first paint and nothing is read for them. For the owner the
 * connection is read once per scope and shared; `read: false` only listens (a
 * surface whose own reply carries the connection settles it instead, and the
 * shell's chrome needs only `owner`).
 */
export function useConnectedCapability(scope?: string | null, options: { read?: boolean } = {}): ConnectedCapability & { revision: number; refresh: () => void } {
  const session = useSession();
  const owner = session.signedIn && session.owner === true;
  const ownerName = session.workspace?.ownerName ?? null;
  const requested = scope === undefined ? session.requestScope : scope;
  const key = session.signedIn && requested === session.requestScope ? requested ?? "" : "";
  const read = options.read !== false;
  const entry = useSyncExternalStore(store.subscribe, () => (key ? store.get(key) : undefined), () => undefined);
  const revision = useSyncExternalStore(store.subscribe, () => key ? store.mark(key) : 0, () => 0);
  /* A bust drops the entry: a surface still on screen reads again. A failed read is not read again on
     its own (that would loop against a refusing route); Try again (`refresh`) or the next surface does. */
  const missing = !entry;
  useEffect(() => { if (owner && read && key) void store.ensure(key); }, [owner, read, key, missing]);
  const refresh = useCallback(() => { if (owner && key) void store.ensure(key, true); }, [owner, key]);
  return useMemo(() => ({ ...capabilityOf(owner, entry, ownerName), revision, refresh }), [owner, entry, ownerName, revision, refresh]);
}

/** Where the scope stands before a surface's own read that carries the connection (Viral's runs, Cast's jobs, Engines). */
export function markConnectedCapability(scope: string | null | undefined): number | undefined {
  return scope ? store.mark(scope) : undefined;
}

/** A surface that read the connection in its own reply shares it with the rest — unless the account changed since `since`. */
export function settleConnectedCapability(scope: string | null | undefined, reply: ConnectionReply, since?: number) {
  return Boolean(scope && reply && typeof reply === "object" && store.settle(scope, reply, since));
}

/** Connecting, reconnecting or disconnecting: every surface reads the account afresh (Workspace › Engines). */
export function bustConnectedCapability(scope: string | null | undefined) {
  if (scope) store.bust(scope);
}
