"use client";
import { useState, type Ref } from "react";

/**
 * Request access (Guest Home frame 3b / P3b): name, email, what you make, and the brief when one is kept. Stored for
 * the platform owner by the existing route (POST /api/access-request, with its honeypot and limits) and listed in
 * /admin. Used by the sign-up sheet and by /signup without an invitation link. `onSent` gets the address.
 */
export function RequestAccessForm({ brief, source, onSent, firstRef }: {
  brief: string;
  /** Where the request came from, for the owner's list ("From guest Home", "From the sign-up page"). */
  source: string;
  onSent: (email: string) => void;
  firstRef?: Ref<HTMLInputElement>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [make, setMake] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function request(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) { setProblem("Tell us your name."); return; }
    setBusy(true);
    setProblem("");
    try {
      const res = await fetch("/api/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, make, brief, note: source, company }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "That didn't send. Try again in a moment.");
      onSent(email.trim());
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="gx-su-form" onSubmit={request} data-testid="request-access-form">
      <label className="gx-su-field">
        <span className="gx-su-label">Name</span>
        <input ref={firstRef} className="gx-su-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" maxLength={120} data-testid="signup-name" />
      </label>
      <label className="gx-su-field">
        <span className="gx-su-label">Email</span>
        <input className="gx-su-input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@studio.com" autoComplete="email" data-testid="signup-email" />
      </label>
      <label className="gx-su-field">
        <span className="gx-su-label">What you make</span>
        <input className="gx-su-input" value={make} onChange={(e) => setMake(e.target.value)} placeholder="Ad films, social clips, music videos…" maxLength={200} data-testid="signup-make" />
      </label>
      {/* Off-screen and out of the tab order: only a bot fills this (the access-request route's honeypot). */}
      <input tabIndex={-1} autoComplete="off" aria-hidden="true" className="gx-su-trap" value={company} onChange={(e) => setCompany(e.target.value)} />
      {problem ? <p className="gx-su-problem" role="alert">{problem}</p> : null}
      <button type="submit" className="gx-primary gx-su-go" disabled={busy} data-testid="signup-request">{busy ? "Sending…" : "Request access"}</button>
    </form>
  );
}

/** The line under a sent request, the same in the sheet and on /signup. */
export function sentLine(credits: string) {
  return `When the link arrives, your brief is waiting on your first board in this browser. ${credits} Nothing is spent without your approval.`;
}

/** The Invite plan line: the platform's welcome credits when known (the platform layer's caps), never a made-up figure. */
export function inviteCredits(welcomeCredits: number | null): string {
  return welcomeCredits != null && welcomeCredits > 0
    ? `Your first ${welcomeCredits.toLocaleString("en-US")} credits are on the house: the Invite plan, free, good for one production.`
    : "The Invite plan is free and good for one production.";
}
