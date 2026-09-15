"use client";

import { useEffect, useRef, useState } from "react";
import { useAtomikQuote } from "@/lib/useAtomikQuote";
import type { PaidTextQuote } from "@/lib/paidText";

/** Only visible scene actions fetch quotes; a long treatment does not fan out on load. */
export default function QuotedAtomikAction({ url, body, label, onRun, disabled, pending, busy, className = "ak-act" }: {
  url: string; body: Record<string, unknown> | null; label: string;
  onRun: (quote?: PaidTextQuote) => void; disabled?: boolean; pending?: boolean; busy?: boolean; className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { quote, error, loading } = useAtomikQuote(url, visible && !pending && !busy ? body : null);
  return <span ref={ref} className="inline-flex min-w-0 flex-col items-start gap-1">
    <button type="button" className={className} disabled={disabled || busy || (!pending && !quote)}
      onClick={() => onRun(pending ? undefined : quote ?? undefined)}>
      {busy ? "Writing…" : pending ? "Recover writing request" : quote ? `${label} · ${quote.estimateUsd === undefined ? `${quote.estimateCredits} cr reserved` : `$${quote.estimateUsd.toFixed(3)} estimate`}` : loading ? "Quoting…" : label}
    </button>
    {error && <span role="status" className="max-w-sm text-[11px] text-dim">{error}</span>}
  </span>;
}
