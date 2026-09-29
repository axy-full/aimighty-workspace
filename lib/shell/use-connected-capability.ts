"use client";
import { useMemo } from "react";
import { useSession } from "@/lib/session";
import type { ConnectedCapability, ConnectionReply } from "./connected-capability";

type Capability = ConnectedCapability & { scope: string; revision: number; refresh: () => void };
const refresh = () => {};

/**
 * Who runs the connected Higgsfield account here: nobody. The sign-in is
 * retired (lib/higgsfield-consumer/retired.ts), so every surface takes the
 * path a member always took — the workspace owner's included — and nothing is
 * read from the account. The answer keeps its shape (`scope`, `revision`,
 * `refresh`) for the pages still on the retired card (Business, Viral and
 * Cast), which go with it once their API-key and Particl versions replace
 * them. Workspace › Engines keeps the owner's grant to Disconnect and the
 * running jobs to Set aside; it never read through here.
 */
export const useConnectedCapability: (scope?: string | null, options?: { read?: boolean }) => Capability = (scope) => {
  const session = useSession();
  const ownerName = session.workspace?.ownerName?.trim() || null;
  const requested = scope === undefined ? session.requestScope : scope;
  const key = session.signedIn && requested === session.requestScope ? requested ?? "" : "";
  return useMemo(() => ({ owner: false, status: "member" as const, connected: false, reconnect: false, error: null, ownerName, scope: key, revision: 0, refresh }), [ownerName, key]);
};

/** Nothing is read, so there is no answer for a surface's own read to be tied to. */
export const markConnectedCapability: (scope: string | null | undefined) => number | undefined = () => undefined;

/** Nothing is kept, so a surface's own reply settles nothing. */
export const settleConnectedCapability: (scope: string | null | undefined, reply: ConnectionReply, since?: number) => boolean = () => false;
