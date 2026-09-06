"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Asking to be let in.
 *
 * This replaces a mailto: link, and the reason is the whole design: a
 * mailto puts the administrator's address in the page source of every
 * visitor, where it is one view-source away from anyone and one crawl away
 * from every scraper. Nothing here knows who the request goes to. The
 * server reads that address, sets reply-to to whoever filled this in, and
 * answers with nothing but "ok".
 *
 * The label says "Contact management" rather than naming a person, because
 * to somebody who has just found the product that is the true description
 * of who they are writing to.
 */

export function RequestAccessButton({ className = "", label = "Request an invite" }: {
  className?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {label}
      </button>
      {/* Portalled to <body>, never rendered beside the button. The button
          lives wherever a sentence needs it — inside a <p> on the login
          page, inside a <span> on the locked panel — and a dialog rendered
          as its sibling puts a <div> and a <form> inside that paragraph,
          which HTML does not allow and React refuses to hydrate. */}
      {open && createPortal(<RequestAccessDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function RequestAccessDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  /* The honeypot. Never shown, never focusable, never filled by a person. */
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Not on a phone: focusing the field opens the keyboard over the dialog.
    if (window.matchMedia("(hover: none)").matches) return;
    const t = setTimeout(() => first.current?.focus(), 40);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => { clearTimeout(t); document.removeEventListener("keydown", esc); };
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/access-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, note, company }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "That didn't send. Try again in a moment.");
      setSent(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-scrim p-5 backdrop-blur-[2px]"
      onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Request an invitation"
        onClick={(e) => e.stopPropagation()}
        className="w-[min(92vw,420px)] rounded-[18px] bg-panel p-5 shadow-[var(--shadow-pop)]">
        {sent ? (
          <>
            <p className="text-[17px] font-semibold tracking-[-0.01em]">That&rsquo;s with management</p>
            <p className="mt-1.5 text-[14px] leading-relaxed text-dim">
              If Particl is a fit for what you&rsquo;re making, you&rsquo;ll get an
              invitation by email. We read every one of these.
            </p>
            <button type="button" onClick={onClose}
              className="btn-render mt-5 w-full py-2.5 text-[15px]">Done</button>
          </>
        ) : (
          <form onSubmit={submit}>
            <p className="text-[17px] font-semibold tracking-[-0.01em]">Ask for an invitation</p>
            <p className="mt-1.5 text-[14px] leading-relaxed text-dim">
              Particl is invitation-only. Tell us where to reach you and a
              little about what you&rsquo;d make with it.
            </p>

            <label className="mt-4 block">
              <span className="lbl">Email</span>
              <input ref={first} className="ctl mt-1.5" type="email" required
                autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="mt-3 block">
              <span className="lbl">Name</span>
              <input className="ctl mt-1.5" type="text" autoComplete="name"
                value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="mt-3 block">
              <span className="lbl">What would you make?</span>
              <textarea className="ctl mt-1.5 !h-auto py-2" rows={3} value={note}
                onChange={(e) => setNote(e.target.value)} />
            </label>

            {/* Off-screen and out of the tab order: only a bot fills this. */}
            <input tabIndex={-1} autoComplete="off" aria-hidden="true"
              className="pointer-events-none absolute left-[-9999px] h-px w-px opacity-0"
              value={company} onChange={(e) => setCompany(e.target.value)} />

            {err && <p className="mt-3 text-[13px] text-lift">{err}</p>}

            <div className="mt-5 flex gap-2">
              <button type="button" onClick={onClose}
                className="chip flex-1 justify-center !py-2.5 !text-[15px] !text-dim">Cancel</button>
              <button type="submit" disabled={busy || !email.trim()}
                className="btn-render flex-1 py-2.5 text-[15px] disabled:opacity-50">
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default RequestAccessButton;
