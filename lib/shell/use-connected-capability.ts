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
 * for a member, the owner's name — comes from the server-rendered session, so a
 * member's surfaces render their card on the first paint and nothing is read
 * for them. For the owner the connection is read once per scope and shared;
 * `read: false` only listens (a surface whose own reply carries the connection
 * settles it instead, and the shell's chrome needs only `owner`).
 */
export function useConnectedCapability(scope?: string | null, options: { read?: boolean } = {}): ConnectedCapability & { refresh: () => void } {
  const session = useSession();
  const owner = session.signedIn && session.owner === true;
  const ownerName = session.workspace?.ownerName ?? null;
  const key = (scope === undefined ? session.requestScope : scope) ?? "";
  const read = options.read !== false;
  const entry = useSyncExternalStore(store.subscribe, () => (key ? store.get(key) : undefined), () => undefined);
  useEffect(() => { if (owner && read && key) void store.ensure(key); }, [owner, read, key]);
  const refresh = useCallback(() => { if (owner && key) void store.ensure(key, true); }, [owner, key]);
  return useMemo(() => ({ ...capabilityOf(owner, entry, ownerName), refresh }), [owner, entry, ownerName, refresh]);
}

/** A surface that read the connection in its own reply shares it with the rest (Viral's runs, Cast's jobs). */
export function settleConnectedCapability(scope: string | null | undefined, reply: ConnectionReply) {
  if (scope && reply && typeof reply === "object") store.settle(scope, reply);
}
