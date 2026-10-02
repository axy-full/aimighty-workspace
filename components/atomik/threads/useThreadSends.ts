"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useSession } from "@/lib/session";
import { lockedClaim, paidActionStorageKey, type PendingPaidAction } from "@/lib/usePaidAction";

/**
 * A planning turn's saved request, one slot per Atomik thread.
 *
 * The paid turn is stored before it is sent and only that exact request can be
 * replayed after a lost reply, as lib/usePaidAction.ts does for every paid
 * action. That hook keeps ONE slot per surface, bound when it renders, so a
 * second thread's turn was refused while another was in flight, and a switch of
 * thread mid-flight read as "saved for recovery". Here the thread is named on
 * every call: each thread's turn is saved, sent and recovered on its own, two
 * threads can plan at once, and switching threads never touches a request in
 * flight. The slots sit beside the old one (`/api/atomik/chat:<project>`), which
 * AtomikProvider still reads for a request saved before threads.
 */

export type ThreadSave = { thread: string; pending: PendingPaidAction | null; error: string | null };

const EVENT = "particl-atomik-thread-sends";
const PREFIX = "particl:paid-action:";
const UNREADABLE = "The saved request cannot be read. Check Activity before starting another paid action.";

/** The slot a thread's planning turn is saved in, under its project (so a project's saved turns can be found). */
export const threadSurface = (project: string | null, thread: string) => `/api/atomik/chat:${project ?? "unfiled"}:${thread}`;

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
    window.removeEventListener(EVENT, listener);
  };
}
const notify = () => window.dispatchEvent(new Event(EVENT));

/** A saved request as lib/usePaidAction.ts writes it; anything else is unreadable. */
function parse(raw: string | null): PendingPaidAction | null {
  if (!raw) return null;
  const request = JSON.parse(raw) as PendingPaidAction;
  if (!request || typeof request.key !== "string" || !request.key || typeof request.url !== "string" || !request.url.startsWith("/api/") || typeof request.body !== "string")
    throw new Error("Invalid request");
  const body = JSON.parse(request.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request body");
  return request;
}
const savedAt = (request: PendingPaidAction | null) => Number((request?.context as { savedAt?: unknown } | undefined)?.savedAt ?? 0) || 0;

/** Every saved turn of this person's threads in one project, newest first (a string, so the snapshot compares by value). */
function scan(workspace: string, email: string, project: string | null): string {
  const lead = threadSurface(project, "");
  const found: ThreadSave[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name?.startsWith(PREFIX)) continue;
      let parts: unknown;
      try { parts = JSON.parse(name.slice(PREFIX.length)); } catch { continue; }
      if (!Array.isArray(parts) || parts[0] !== workspace || parts[1] !== email || typeof parts[2] !== "string" || !parts[2].startsWith(lead)) continue;
      const thread = parts[2].slice(lead.length);
      if (!thread) continue;
      try {
        const pending = parse(localStorage.getItem(name));
        if (pending) found.push({ thread, pending, error: null });
      } catch {
        found.push({ thread, pending: null, error: UNREADABLE });
      }
    }
  } catch {
    return "[]";
  }
  found.sort((a, b) => savedAt(b.pending) - savedAt(a.pending) || a.thread.localeCompare(b.thread));
  return JSON.stringify(found);
}

export function useThreadSends(project: string | null) {
  const { signedIn, workspace, email } = useSession();
  const enabled = !!(signedIn && workspace?.id && email);
  const ws = workspace?.id ?? "", who = email ?? "";
  const snapshot = useCallback(() => (enabled ? scan(ws, who, project) : "[]"), [enabled, ws, who, project]);
  const saved = JSON.parse(useSyncExternalStore(subscribe, snapshot, () => "[]")) as ThreadSave[];
  /* Who is signed in now, for a reply that lands after a switch of account or workspace. */
  const identity = useRef(JSON.stringify([ws, who]));
  useEffect(() => { identity.current = JSON.stringify([ws, who]); }, [ws, who]);

  const complete = useCallback((storageKey: string, requestKey: string) => lockedClaim(storageKey, () => {
    try {
      if (parse(localStorage.getItem(storageKey))?.key === requestKey) { localStorage.removeItem(storageKey); notify(); }
    } catch { /* unreadable: left for Activity, as the shared hook leaves it */ }
  }), []);

  /**
   * Send a thread's planning turn, saved first. `recovering` is the key of the
   * saved request being replayed: the replay is that exact request, or nothing.
   */
  const run = useCallback(async (thread: string, url: string, body: Record<string, unknown>, recovering?: string) => {
    if (!enabled) throw new Error("Sign in to the original workspace before starting this request.");
    const sentAs = JSON.stringify([ws, who]);
    const storageKey = paidActionStorageKey(ws, who, threadSurface(project, thread));
    let request: PendingPaidAction;
    try {
      request = await lockedClaim(storageKey, () => {
        const saved = parse(localStorage.getItem(storageKey));
        if (recovering && (!saved || saved.key !== recovering)) throw new Error("The saved request was already recovered. Refresh before starting another.");
        if (saved && (saved.url !== url || saved.body !== JSON.stringify(body))) throw new Error("Recover the saved request before starting another paid action.");
        const claimed: PendingPaidAction = saved ?? { key: crypto.randomUUID(), url, body: JSON.stringify(body), context: { savedAt: Date.now() } };
        localStorage.setItem(storageKey, JSON.stringify(claimed));
        if (localStorage.getItem(storageKey) !== JSON.stringify(claimed)) throw new Error("Storage unavailable");
        notify();
        return claimed;
      });
    } catch (error) {
      throw new Error(error instanceof Error && (error.message.startsWith("Recover the saved") || error.message.startsWith("The saved request was already")) ? error.message : UNREADABLE);
    }
    if (identity.current !== sentAs) throw new Error("The request is saved for recovery in its original workspace.");
    const response = await fetch(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": request.key, "X-Workspace-Id": ws, "X-Actor-Email": who },
      body: request.body,
    });
    const data = await response.json().catch(() => null);
    const final = response.headers.get("Idempotency-Status") === "complete";
    if (!response.ok) {
      /* A reply the server recorded as final (a refusal, an archived thread) ends the saved request: it can only answer the same. */
      if (final) await complete(storageKey, request.key);
      throw new Error(data?.error || "The response could not be confirmed. Recover the saved request.");
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || (!final && typeof data.id !== "string" && typeof data.identity?.id !== "string"))
      throw new Error("The response could not be confirmed. Recover the saved request.");
    /* Confirmed: the request is done wherever this person now is, so its slot is cleared. */
    await complete(storageKey, request.key);
    if (identity.current !== sentAs) throw new Error("The request is saved for recovery in its original workspace.");
    return { data, request };
  }, [enabled, ws, who, project, complete]);

  const pendingOf = useCallback((thread: string | null) => (thread ? saved.find((s) => s.thread === thread) ?? null : null), [saved]);
  return { saved, pendingOf, run };
}

/* ── The thread a tab is on ──────────────────────────────────────────────── */

const pickListeners = new Set<() => void>();
const subscribePick = (listener: () => void) => { pickListeners.add(listener); return () => { pickListeners.delete(listener); }; };

/**
 * The thread this tab last picked in a project, so a reload, or a return to the
 * Suites Agent page, keeps the person where they were. Per tab (session
 * storage), never shared: a link with no thread in it, opened anywhere else,
 * still opens the thread with the newest activity. A convenience only; without
 * storage it is simply forgotten.
 */
export function useRememberedThread(scope: string) {
  const name = scope ? `particl:atomik-thread:${scope}` : "";
  const read = useCallback(() => {
    if (!name) return "";
    try { return sessionStorage.getItem(name) ?? ""; } catch { return ""; }
  }, [name]);
  const id = useSyncExternalStore(subscribePick, read, () => "");
  const remember = useCallback((thread: string | null) => {
    if (!name) return;
    try {
      if (thread) sessionStorage.setItem(name, thread);
      else sessionStorage.removeItem(name);
    } catch { /* per-tab convenience only */ }
    for (const listener of pickListeners) listener();
  }, [name]);
  return [id || null, remember] as const;
}
