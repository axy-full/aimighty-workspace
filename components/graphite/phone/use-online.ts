"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { reviewProjectTake } from "@/lib/workspace/library";
import { queueJudgement, readQueued, type QueuedJudgement } from "./phone-model";

/** Whether the browser says it has a connection; true on the server and before it says otherwise. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (notify) => { window.addEventListener("online", notify); window.addEventListener("offline", notify); return () => { window.removeEventListener("online", notify); window.removeEventListener("offline", notify); }; },
    () => navigator.onLine,
    () => true,
  );
}

/*
 * Judgements made offline, kept in this browser per workspace scope until they are sent. Only free judging
 * waits here (approve, send back, undo); nothing that spends is ever queued.
 */
const keyOf = (scope: string) => `particl:phone-judged:${scope}`;
const listeners = new Set<() => void>();
const cache = new Map<string, QueuedJudgement[]>();

function read(scope: string): QueuedJudgement[] {
  if (!cache.has(scope)) {
    let list: QueuedJudgement[] = [];
    try { list = readQueued(JSON.parse(localStorage.getItem(keyOf(scope)) ?? "[]")); } catch { /* no storage: nothing kept */ }
    cache.set(scope, list);
  }
  return cache.get(scope)!;
}
function write(scope: string, list: QueuedJudgement[]) {
  cache.set(scope, list);
  try { if (list.length) localStorage.setItem(keyOf(scope), JSON.stringify(list)); else localStorage.removeItem(keyOf(scope)); } catch { /* kept for this tab */ }
  listeners.forEach((notify) => notify());
}
const EMPTY: QueuedJudgement[] = [];

/** The phone's offline judgements: queue one, and send them all, oldest first, once the phone is back online. */
export function useQueuedJudgements(scope: string) {
  const online = useOnline();
  const list = useSyncExternalStore(
    (notify) => { listeners.add(notify); return () => { listeners.delete(notify); }; },
    () => read(scope),
    () => EMPTY,
  );
  const add = useCallback((judgement: QueuedJudgement) => write(scope, queueJudgement(read(scope), judgement)), [scope]);
  useEffect(() => {
    if (!online || !list.length) return;
    let live = true;
    void (async () => {
      for (const j of read(scope)) {
        if (!live) return;
        try {
          await reviewProjectTake(scope, j.projectId, j.generationId, j.state);
        } catch {
          /* Still unreachable, or refused (a take that is gone): a refusal is not retried for ever. */
          if (!navigator.onLine) return;
        }
        write(scope, read(scope).filter((k) => !(k.generationId === j.generationId && k.at === j.at)));
      }
    })();
    return () => { live = false; };
  }, [online, list.length, scope]);
  return { queued: list, add };
}
