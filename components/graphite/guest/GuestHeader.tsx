"use client";
import Link from "next/link";
import { TRAIL } from "@/components/ui/Mark";
import { Glyph, SEGMENT_LOOK } from "../icons";

/**
 * The signed-out header (Guest Home frames 1 and 2; README § 3.7): the particl mark and its pill, the segment
 * Home · Make · Atomik with no project, Search, then **Sign in** (secondary) and **Sign up**, the one filled button.
 * Make, Atomik and Search open the sign-up sheet: nothing that thinks runs for a guest. On a phone the segment and
 * Search fold away and both buttons are 44 px.
 */
export function GuestHeader({ mark, view, onHome, onGated, onSignup }: {
  mark: "HOME" | "BOARD";
  view: "home" | "sample";
  onHome: () => void;
  /** Make, Atomik and Search: each opens the sheet. */
  onGated: () => void;
  onSignup: () => void;
}) {
  const segments = [
    { id: "home" as const, label: "Home", on: view === "home", run: onHome },
    { id: "make" as const, label: "Make", on: false, run: onGated },
    { id: "atomik" as const, label: "Atomik", on: false, run: onGated },
  ];
  return (
    <header className="gx-header gx-gh-header" data-testid="guest-header">
      {view === "sample" ? (
        <button type="button" className="gx-gh-back" onClick={onHome} aria-label="Back to Home" data-testid="guest-back"><span aria-hidden="true">‹</span></button>
      ) : null}
      <button type="button" className="gx-brand" onClick={onHome} aria-label="particl home" data-testid="guest-brand">
        <svg width="30" height="14" viewBox="30 68 140 64" fill="currentColor" aria-hidden="true">
          {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
        </svg>
        <span className="gx-brand-name">particl</span>
        <span className="gx-brand-mark gx-gh-mark">{mark}</span>
        <span className="gx-gh-title">{view === "sample" ? "Sample" : "Particl"}</span>
      </button>
      <div className="gx-seg gx-gh-seg" role="tablist" aria-label="Go to">
        {segments.map((s) => (
          <button key={s.id} type="button" role="tab" className="gx-seg-btn" aria-selected={s.on} onClick={s.run} data-testid={`guest-tab-${s.id}`}>
            <Glyph name={SEGMENT_LOOK[s.id].glyph} size={13} className="gx-glyph" />
            <span className="gx-seg-label">{s.label}</span>
          </button>
        ))}
      </div>
      <button type="button" className="gx-search gx-gh-search" onClick={onGated} aria-label="Search" data-testid="guest-search">
        <Glyph name="search" size={13} className="gx-glyph" />
        <span className="gx-search-label">Search</span>
        <span className="gx-key">⌘K</span>
      </button>
      <span className="gx-spacer" />
      <Link href="/login" className="gx-hbtn gx-gh-signin" data-testid="guest-signin">Sign in</Link>
      <button type="button" className="gx-primary gx-gh-signup" onClick={onSignup} data-testid="guest-signup">Sign up</button>
    </header>
  );
}
