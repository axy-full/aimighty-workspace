"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import ParticlLockup from "./ParticlMark";
import { AtomikMark, AtomikLockup } from "./AtomikMark";

/**
 * Particl or Atomik.
 *
 * The two are the same studio seen from different heights. Particl is the
 * instrument: you describe one shot and it renders that shot. Atomik is the
 * producer: you describe a production and it works out the shots, proposing
 * each one for approval. They share the projects, the cast, the engines and
 * the ledger — what changes is who decides what to render.
 *
 * So this is a product switch rather than a tab. A tab says "another screen
 * in the same app"; this says "the same work, run a different way", which
 * is why it sits on the brand at the top-left instead of down in the nav —
 * and why the nav underneath it changes when you flip it.
 */

const LAST_PARTICL_KEY = "aw_last_particl";

export default function ModeSwitch() {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const onAtomik = path.startsWith("/atomik");

  /* Coming back should return you to the screen you left, not to the top of
     the app. Session storage rather than local: it is a within-visit
     courtesy, and a week-old "you were on /usage" is noise. */
  useEffect(() => {
    if (onAtomik) return;
    try { sessionStorage.setItem(LAST_PARTICL_KEY, path); } catch { /* private mode */ }
  }, [path, onAtomik]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  function go(to: "particl" | "atomik") {
    setOpen(false);
    if (to === "atomik") { router.push("/atomik"); return; }
    let back = "/";
    try { back = sessionStorage.getItem(LAST_PARTICL_KEY) || "/"; } catch { /* private mode */ }
    router.push(back.startsWith("/atomik") ? "/" : back);
  }

  return (
    <div ref={wrap} className="relative shrink-0">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="mode-switch" aria-haspopup="menu" aria-expanded={open}
        title={onAtomik ? "Atomik — switch back to Particl" : "Particl — switch to Atomik"}>
        {/* Both modes wear a lockup, not a bare glyph: the switch is the
            app's identity, and an identity that shrinks to an unlabelled
            icon in one of its two states reads as a loading failure. */}
        {onAtomik
          ? <AtomikLockup size={17} className="max-[430px]:[&_.atomik-word]:hidden" />
          : <ParticlLockup size={19} studio={false} className="max-[430px]:[&_.wordmark]:hidden" />}
        <svg viewBox="0 0 10 14" aria-hidden className="mode-switch-caret">
          <path d="M5 1.5 8 5M5 12.5 8 9M5 1.5 2 5M5 12.5 2 9"
            fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div role="menu" className="mode-pop pop-surface">
          <button type="button" role="menuitemradio" aria-checked={!onAtomik}
            onClick={() => go("particl")}
            className={`mode-item ${!onAtomik ? "is-on" : ""}`}>
            <ParticlLockup size={17} studio={false} className="[&_.wordmark]:hidden" />
            <span className="min-w-0 flex-1">
              <span className="mode-item-name">Particl</span>
              <span className="mode-item-note">Render a shot at a time</span>
            </span>
            {!onAtomik && <Tick />}
          </button>
          <button type="button" role="menuitemradio" aria-checked={onAtomik}
            onClick={() => go("atomik")}
            className={`mode-item ${onAtomik ? "is-on" : ""}`}>
            <AtomikMark size={17} />
            <span className="min-w-0 flex-1">
              <span className="mode-item-name">Atomik</span>
              <span className="mode-item-note">Describe it, approve what it costs</span>
            </span>
            {onAtomik && <Tick />}
          </button>
        </div>
      )}
    </div>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className="h-3.5 w-3.5 shrink-0 text-blue">
      <path d="M2 7.5 5.5 11 12 3.5" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
