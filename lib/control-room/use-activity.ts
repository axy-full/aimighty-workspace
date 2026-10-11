"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { APPROVALS_CHANGED } from "./approve";
import type { ActivityReply } from "./activity";

/**
 * Activity in the browser: GET /api/control-room/activity for one production
 * (null: every one), read on arrival, again on a pace (often while a run moves
 * or waits, rarely otherwise), when the window comes back, and after any
 * approval on the page. The control room's Activity and the board's Project
 * record read it through this hook.
 */
export const ACTIVITY_ACTIVE_POLL_MS = 15_000;
export const ACTIVITY_IDLE_POLL_MS = 60_000;
export const ACTIVITY_READ_FAILED = "Activity could not be read.";

export type ActivityState = {
  status: "loading" | "ready" | "error";
  reply: ActivityReply | null;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useActivity(production: string | null, options: { enabled?: boolean } = {}): ActivityState {
  const enabled = options.enabled ?? true;
  const session = useSession();
  const scope = session.requestScope ?? null;
  const fetcher = useScopedFetch(scope);
  const key = JSON.stringify([scope, production]);
  const [load, setLoad] = useState<{ key: string; status: ActivityState["status"]; reply: ActivityReply | null; error: string | null }>({ key, status: "loading", reply: null, error: null });
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !scope) return;
    const mine = ++sequence.current;
    try {
      const response = await fetcher(`/api/control-room/activity${production ? `?production=${encodeURIComponent(production)}` : ""}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as (ActivityReply & { error?: string }) | null;
      if (!response.ok || !body || !Array.isArray(body.runs)) throw new Error(body?.error || ACTIVITY_READ_FAILED);
      if (mine === sequence.current) setLoad({ key, status: "ready", reply: body, error: null });
    } catch (error) {
      if (mine !== sequence.current) return;
      const message = error instanceof Error && error.message && error.message !== "Failed to fetch" ? error.message : ACTIVITY_READ_FAILED;
      setLoad((previous) => ({ key, status: previous.key === key && previous.reply ? "ready" : "error", reply: previous.key === key ? previous.reply : null, error: message }));
    }
  }, [enabled, scope, fetcher, production, key]);

  const current = load.key === key ? load : { key, status: "loading" as const, reply: null, error: null };
  const moving = (current.reply?.runs ?? []).some((r) => r.state === "planning" || r.state === "running" || r.state === "needs-you" || r.settling);
  useEffect(() => {
    if (!enabled || !scope) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, moving ? ACTIVITY_ACTIVE_POLL_MS : ACTIVITY_IDLE_POLL_MS);
    const again = () => void refresh();
    window.addEventListener(APPROVALS_CHANGED, again);
    window.addEventListener("focus", again);
    return () => { clearTimeout(first); clearInterval(timer); window.removeEventListener(APPROVALS_CHANGED, again); window.removeEventListener("focus", again); };
  }, [enabled, scope, refresh, moving]);

  return { status: current.status, reply: current.reply, error: current.error, refresh };
}
