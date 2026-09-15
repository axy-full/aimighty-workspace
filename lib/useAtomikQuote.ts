"use client";

import { useEffect, useState } from "react";
import { useSession } from "./session";
import type { PaidTextQuote } from "./paidText";

/** Quotes are scoped reads. Only an answer matching the current input may enable Run. */
export function useAtomikQuote(url: string, body: Record<string, unknown> | null) {
  const { signedIn, workspace, email } = useSession();
  const request = body ? JSON.stringify(body) : "";
  const scope = signedIn && workspace?.id && email ? JSON.stringify([workspace.id, email]) : "";
  const key = request && scope ? JSON.stringify([scope, url, request]) : "";
  const [result, setResult] = useState<{ key: string; quote?: PaidTextQuote; error?: string } | null>(null);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const [workspaceId, actorEmail] = JSON.parse(scope) as [string, string];
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId, "X-Actor-Email": actorEmail },
          body: JSON.stringify({ ...JSON.parse(request), quoteOnly: true }),
          signal: controller.signal,
        });
        const quote = await response.json();
        if (!response.ok) throw new Error(quote.error ?? "The writing quote is unavailable.");
        if (typeof quote.model !== "string" || !Number.isInteger(quote.estimateCredits) || quote.estimateCredits < 0 || (quote.estimateUsd !== undefined && !Number.isFinite(quote.estimateUsd)))
          throw new Error("The writing quote is incomplete. Try again before running.");
        if (!controller.signal.aborted) setResult({ key, quote });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "The writing quote is unavailable." });
      }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, request, scope, url]);

  const current = result?.key === key ? result : null;
  return { quote: current?.quote ?? null, error: current?.error ?? null, loading: !!key && !current };
}
