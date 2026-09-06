"use client";

import { useState } from "react";
import Link from "next/link";
import { usePageTitle } from "@/lib/usePageTitle";
import { REPORT_REASONS, REASON_LABELS } from "@/lib/reports";

/** Report something that should not be here. No account needed. */
export default function ReportPage() {
  usePageTitle("Report content");
  const [url, setUrl] = useState("");
  const [reason, setReason] = useState<string>("real-person");
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, reason, details, email }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Could not send it");
      setSent(true);
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <div className="screen">
      <div className="mx-auto w-full max-w-[560px] pb-12">
        <div className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
          <Link href="/policy" className="text-blue">Content policy</Link>
          <Link href="/terms" className="text-blue">Terms</Link>
          <Link href="/privacy" className="text-blue">Privacy &amp; retention</Link>
        </div>
        <h1 className="h1 mt-3">Report content</h1>
        <p className="mt-3 max-w-[56ch] text-[15px] text-dim">A link or a take id, what is wrong, and a way to reach you if you want one. The desk reads every report.</p>
        {sent ? (
          <section className="card mt-6 px-5 py-5"><p className="text-[15px]">Thank you. It has reached the desk.</p></section>
        ) : (
          <form onSubmit={submit} className="card mt-6 flex flex-col gap-3 px-5 py-5">
            <label className="flex flex-col gap-1 text-[12.5px] text-dim">Where
              <input className="ctl" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="A link, or a take id" /></label>
            <label className="flex flex-col gap-1 text-[12.5px] text-dim">What is wrong
              <select className="ctl" value={reason} onChange={(e) => setReason(e.target.value)}>
                {REPORT_REASONS.map((r) => <option key={r} value={r}>{REASON_LABELS[r]}</option>)}
              </select></label>
            <label className="flex flex-col gap-1 text-[12.5px] text-dim">Details, if any
              <textarea className="ctl !h-24" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} /></label>
            <label className="flex flex-col gap-1 text-[12.5px] text-dim">Your email, if you want an answer
              <input className="ctl" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <div><button type="submit" className="btn-primary" disabled={busy}>{busy ? "Sending…" : "Send the report"}</button></div>
            {err && <p className="text-[13px] text-lift">{err}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
