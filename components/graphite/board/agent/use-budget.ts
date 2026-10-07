"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { APPROVALS_CHANGED } from "@/lib/control-room/approve";
import { recordBudget, type RecordBudget } from "@/lib/shell/project-record";

/**
 * The production's budget and what it has spent, as the Record shows them: today's `GET /api/productions` (people
 * only, this workspace only; credits only in a credits workspace), the project row whose id is the board's production.
 * `cap` and `spent` are the figures the reservation gate enforces (lib/caps.ts).
 */
type Row = { id: string; capCredits: number | null; spentCredits?: number };
type Reply = { productions?: { projects?: Row[] }[] };

export function useBudget(productionId: string | null, enabled = true): { budget: RecordBudget | null; error: boolean } {
  const session = useSession();
  const scope = session.requestScope ?? null;
  const fetcher = useScopedFetch(scope);
  const [state, setState] = useState<{ key: string; budget: RecordBudget | null; error: boolean }>({ key: "", budget: null, error: false });
  const key = `${scope}|${productionId}`;
  const seq = useRef(0);
  const read = useCallback(async () => {
    if (!enabled || !scope || !productionId) return;
    const mine = ++seq.current;
    try {
      const response = await fetcher("/api/productions", { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as Reply | null;
      if (!response.ok || !body?.productions) throw new Error("read");
      const row = body.productions.flatMap((p) => p.projects ?? []).find((r) => r.id === productionId);
      const next = recordBudget({ inCredits: row ? row.spentCredits !== undefined : true, cap: row?.capCredits ?? null, spent: row?.spentCredits ?? null });
      if (mine === seq.current) setState({ key, budget: row ? next : { kind: "unbilled" }, error: false });
    } catch {
      if (mine === seq.current) setState((was) => ({ key, budget: was.key === key ? was.budget : null, error: true }));
    }
  }, [enabled, scope, productionId, fetcher, key]);
  useEffect(() => {
    if (!enabled) return;
    const first = setTimeout(() => void read(), 0);
    const every = setInterval(() => { if (document.visibilityState !== "hidden") void read(); }, 60_000);
    window.addEventListener(APPROVALS_CHANGED, read);
    return () => { clearTimeout(first); clearInterval(every); window.removeEventListener(APPROVALS_CHANGED, read); };
  }, [enabled, read]);
  return state.key === key ? { budget: state.budget, error: state.error } : { budget: null, error: false };
}
