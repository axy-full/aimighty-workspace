"use client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useSession } from "./session";

export type PendingPaidAction = {
  key: string;
  url: string;
  body: string;
  context?: Record<string, unknown>;
};
const eventName = "particl-paid-action-storage";
const subscribe = (listener: () => void) => {
  window.addEventListener("storage", listener);
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(eventName, listener);
  };
};
const serverSnapshot = () => "{}";
const notify = () => window.dispatchEvent(new Event(eventName));
export const paidActionStorageKey = (
  workspaceId: string,
  email: string,
  surface: string,
) => `particl:paid-action:${JSON.stringify([workspaceId, email, surface])}`;
function read(key: string): PendingPaidAction | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const request = JSON.parse(raw) as PendingPaidAction;
  if (
    !request ||
    typeof request.key !== "string" ||
    !request.key ||
    typeof request.url !== "string" ||
    !request.url.startsWith("/api/") ||
    typeof request.body !== "string"
  )
    throw new Error("Invalid request");
  const body = JSON.parse(request.body);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid request body");
  return request;
}
const claimQueues = new Map<string, Promise<unknown>>();
export async function lockedClaim<T>(key: string, claim: () => T): Promise<T> {
  if (navigator.locks) return navigator.locks.request(key, claim);
  const previous = claimQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(claim);
  claimQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (claimQueues.get(key) === next) claimQueues.delete(key);
  }
}
const unreadable =
  "The saved request cannot be read. Check Activity before starting another paid action.";

/** Store one exact request before spending; a lost response can only replay that request. */
export function usePaidAction(surface: string, active = true, workbench?: { signedIn: boolean; requestScope: string }) {
  const { signedIn, workspace, email } = useSession();
  const requestScope = workbench?.requestScope;
  const enabled = workbench
    ? !!(workbench.signedIn && requestScope && active)
    : !!(signedIn && workspace?.id && email && active);
  const storageKey = paidActionStorageKey(
    requestScope ?? workspace?.id ?? "",
    requestScope ? "workbench" : email ?? "",
    surface,
  );
  const current = useRef({ key: storageKey, active: enabled });
  useEffect(() => {
    current.current = { key: storageKey, active: enabled };
    return () => {
      current.current.active = false;
    };
  }, [storageKey, enabled]);
  const snapshot = useCallback(() => {
    if (!enabled) return "{}";
    try {
      return JSON.stringify({ pending: read(storageKey) });
    } catch {
      return JSON.stringify({ error: unreadable });
    }
  }, [storageKey, enabled]);
  const state = JSON.parse(
    useSyncExternalStore(subscribe, snapshot, serverSnapshot),
  ) as { pending?: PendingPaidAction | null; error?: string };
  const recoveryKey = state.pending?.key;
  const complete = useCallback(
    (requestKey: string) =>
      lockedClaim(storageKey, () => {
        if (read(storageKey)?.key === requestKey) {
          localStorage.removeItem(storageKey);
          notify();
        }
      }),
    [storageKey],
  );
  const run = useCallback(
    async <T extends object = Record<string, unknown>>(
      url: string,
      body: Record<string, unknown>,
      options?: { context?: Record<string, unknown>; keepPending?: boolean },
    ): Promise<{ data: T; request: PendingPaidAction }> => {
      if (
        !enabled ||
        !current.current.active ||
        current.current.key !== storageKey
      )
        throw new Error(
          "Sign in to the original workspace before starting this request.",
        );
      let request: PendingPaidAction;
      try {
        request = await lockedClaim(storageKey, () => {
          const saved = read(storageKey);
          if (recoveryKey && (!saved || saved.key !== recoveryKey))
            throw new Error(
              "The saved request was already recovered. Refresh before starting another.",
            );
          if (
            saved &&
            (saved.url !== url || saved.body !== JSON.stringify(body))
          )
            throw new Error(
              "Recover the saved request before starting another paid action.",
            );
          const claimed = saved ?? {
            key: crypto.randomUUID(),
            url,
            body: JSON.stringify(body),
            context: options?.context,
          };
          localStorage.setItem(storageKey, JSON.stringify(claimed));
          if (localStorage.getItem(storageKey) !== JSON.stringify(claimed))
            throw new Error("Storage unavailable");
          notify();
          return claimed;
        });
      } catch (error) {
        throw new Error(
          error instanceof Error &&
            (error.message.startsWith("Recover the saved") ||
              error.message.startsWith("The saved request was already"))
            ? error.message
            : unreadable,
        );
      }
      if (!current.current.active || current.current.key !== storageKey)
        throw new Error(
          "The request is saved for recovery in its original workspace.",
        );
      const response = await fetch(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": request.key,
          ...(requestScope
            ? { "X-Workbench-Scope": requestScope }
            : { "X-Workspace-Id": workspace!.id, "X-Actor-Email": email! }),
        },
        body: request.body,
      });
      const data = await response.json().catch(() => null);
      if (!current.current.active || current.current.key !== storageKey)
        throw new Error(
          "The request is saved for recovery in its original workspace.",
        );
      if (!response.ok) {
        if (response.headers.get("Idempotency-Status") === "complete")
          await complete(request.key);
        throw new Error(
          data?.error ||
            "The response could not be confirmed. Recover the saved request.",
        );
      }
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        (response.headers.get("Idempotency-Status") !== "complete" &&
          typeof data.id !== "string" &&
          typeof data.identity?.id !== "string")
      )
        throw new Error(
          "The response could not be confirmed. Recover the saved request.",
        );
      if (!options?.keepPending) await complete(request.key);
      return { data, request };
    },
    [storageKey, enabled, complete, workspace, email, recoveryKey, requestScope],
  );
  return {
    pending: state.pending ?? null,
    error: state.error ?? null,
    run,
    complete,
  };
}
export type PaidAction = ReturnType<typeof usePaidAction>;
