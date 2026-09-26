"use client";

import { useState } from "react";
import { Dot } from "./ui";

/**
 * The site's request-access form: the same endpoint and honeypot as the app's
 * dialog (components/RequestAccess.tsx), inline instead of in a dialog. The
 * server keeps the request even when its email fails to send, so "Noted"
 * is true as soon as it answers ok.
 */
export default function AccessForm() {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: "", note: "From the site", company }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "That didn't send. Try again in a moment.");
      setSent(true);
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="mk-sent" role="status">
        <Dot state="done" />
        Noted. An invite link comes from a person, not a mailer.
      </div>
    );
  }
  return (
    <form className="mk-access-form" onSubmit={submit}>
      <label className="mk-sr" htmlFor="mk-access-email">Work email</label>
      <input id="mk-access-email" className="mk-input" type="email" required autoComplete="email"
        placeholder="you@studio.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      {/* Off-screen and out of the tab order: only a bot fills this. */}
      <input tabIndex={-1} autoComplete="off" aria-hidden="true" className="mk-trap"
        value={company} onChange={(e) => setCompany(e.target.value)} />
      <button type="submit" className="mk-btn gx-primary" disabled={busy}>
        {busy ? "Sending…" : "Request access"}
      </button>
      {error && <p className="mk-error" role="alert" style={{ flexBasis: "100%" }}>{error}</p>}
    </form>
  );
}
