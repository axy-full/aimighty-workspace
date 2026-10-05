"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

type Invite = { state: "checking" } | { state: "ready"; email: string } | { state: "bad"; message: string };

/**
 * The sign-up sheet a guest meets on anything that thinks, spends or keeps work (Guest Home frames 3a, 3b, P3a,
 * P3b; README § 3.7). Centred on a desktop, a bottom sheet on a phone.
 *
 * - With an invitation link (`invite`): the brief kept, the invitation's email, and **Create account**, which
 *   continues on today's /signup form for that invitation (name, workspace, password, terms). Sign-in and account
 *   creation are unchanged.
 * - Without one: Particl is invite-only. Name, email, what you make and **Request access**, stored for the platform
 *   owner (POST /api/access-request, its honeypot and limits); the brief rides along in the request.
 *
 * The one filled button is Create account or Request access. Nothing here thinks or spends.
 */
export function SignupSheet({ invite, brief, welcomeCredits, onClose }: {
  invite: string | null;
  brief: string;
  /** The credits an approved invitation starts with (the platform layer's caps), or null when unknown. */
  welcomeCredits: number | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const first = useRef<HTMLInputElement>(null);
  const [inv, setInv] = useState<Invite | null>(invite ? { state: "checking" } : null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [make, setMake] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (!invite) return;
    const controller = new AbortController();
    fetch("/api/auth/signup?code=" + encodeURIComponent(invite), { signal: controller.signal, cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { email?: string; error?: string };
        setInv(r.ok && j.email ? { state: "ready", email: j.email } : { state: "bad", message: j.error || "That invitation link can't be used." });
      })
      .catch(() => { if (!controller.signal.aborted) setInv({ state: "bad", message: "The invitation couldn't be checked. Try again." }); });
    return () => controller.abort();
  }, [invite]);

  useEffect(() => { first.current?.focus(); }, [inv?.state]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const withInvite = inv?.state === "ready";
  const credits = welcomeCredits != null && welcomeCredits > 0 ? `Your first ${welcomeCredits.toLocaleString("en-US")} credits are on the house: the Invite plan, free, good for one production.` : "The Invite plan is free and good for one production.";

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
        body: JSON.stringify({ name, email, make, brief, note: "From guest Home", company }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "That didn't send. Try again in a moment.");
      setSent(email.trim());
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = withInvite ? "Create your account" : sent ? "Request sent" : "Particl is invite-only for now.";
  const sub = withInvite ? "You have an invitation link." : sent ? `We’ll email a link to ${sent}.` : "Ask for access and we’ll send you a link.";

  return (
    <div className="gx-su-layer" data-testid="signup-sheet">
      <div className="gx-su-scrim" onClick={onClose} aria-hidden="true" />
      <div className="gx-su" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="gx-su-grab" aria-hidden="true" />
        <button type="button" className="gx-su-x" onClick={onClose} aria-label="Close" data-testid="signup-close">×</button>
        <div>
          <p className="gx-su-eyebrow">Sign up</p>
          <h2 className="gx-su-title" id={titleId}>{title}</h2>
          <p className="gx-su-sub">{sub}</p>
        </div>
        {brief.trim() && !sent ? (
          <div className="gx-su-field">
            <span className="gx-su-label">Your brief · kept for your first board</span>
            <p className="gx-su-brief" data-testid="signup-brief"><span>{brief.trim()}</span></p>
          </div>
        ) : null}
        {inv?.state === "checking" ? <p className="gx-su-sub" role="status">Checking your invitation…</p> : null}
        {inv?.state === "bad" ? <p className="gx-su-problem" role="alert">{inv.message}</p> : null}
        {withInvite ? (
          <>
            <label className="gx-su-field">
              <span className="gx-su-label">Email</span>
              <input ref={first} className="gx-su-input" type="email" value={inv.email} readOnly data-testid="signup-email" />
            </label>
            <Link className="gx-primary gx-su-go" href={`/signup?invite=${encodeURIComponent(invite!)}`} data-testid="signup-create">Create account</Link>
            <p className="gx-su-note">{credits} Nothing is spent without your approval.</p>
          </>
        ) : sent ? (
          <p className="gx-su-note" data-testid="signup-sent">When the link arrives, your brief is waiting on your first board in this browser. {credits} Nothing is spent without your approval.</p>
        ) : inv?.state === "checking" ? null : (
          <form className="gx-su-form" onSubmit={request}>
            <label className="gx-su-field">
              <span className="gx-su-label">Name</span>
              <input ref={first} className="gx-su-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" maxLength={120} data-testid="signup-name" />
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
        )}
        <div className="gx-su-foot">
          <span>Already have an account?</span>
          <Link href="/login" className="gx-su-link" data-testid="signup-signin">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
