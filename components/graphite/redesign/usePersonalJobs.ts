"use client";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/session";

type Counts = { rendering: number; held: number };
/** Read every active page, scoped to the signed-in person. This never polls a provider. */
export function usePersonalJobs() {
  const { signedIn, requestScope } = useSession();
  const [result, setResult] = useState<{ owner: string; counts?: Counts; error?: true } | null>(null);
  useEffect(() => {
    if (!signedIn || !requestScope) return;
    const controller = new AbortController();
    let busy = false;
    const read = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const rows = new Map<string, string>();
        // Separate status queries avoid downloading the person's completed history.
        for (const status of ["queued", "running", "held"]) {
          let cursor: string | null = null;
          const visited = new Set<string>();
          do {
            const params = new URLSearchParams({ mine: "1", sync: "0", status, pagination: "stable", limit: "200" });
            if (cursor) params.set("cursor", cursor);
            const response = await fetch(`/api/jobs?${params}`, { cache: "no-store", headers: { "X-Workbench-Scope": requestScope }, signal: controller.signal });
            if (!response.ok) throw new Error("Jobs could not be read");
            const body = await response.json() as { generations: { id: string; status: string }[]; nextPageCursor?: string | null };
            for (const job of body.generations) rows.set(job.id, job.status);
            cursor = body.nextPageCursor ?? null;
            if (cursor && visited.has(cursor)) throw new Error("Repeated page");
            if (cursor) visited.add(cursor);
          } while (cursor);
        }
        const values = [...rows.values()];
        if (!controller.signal.aborted) setResult({ owner: requestScope, counts: { rendering: values.filter((s) => s === "queued" || s === "running").length, held: values.filter((s) => s === "held").length } });
      } catch {
        if (!controller.signal.aborted) setResult({ owner: requestScope, error: true });
      } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 30_000);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", read); window.removeEventListener("focus", read); };
  }, [signedIn, requestScope]);
  return signedIn && requestScope && result?.owner === requestScope ? result : null;
}
