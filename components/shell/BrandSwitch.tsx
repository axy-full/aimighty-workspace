"use client";

/**
 * The logo is the switch.
 *
 * Particl and Atomik are the same studio seen from different heights —
 * Atomik writes the production (idea → treatment → breakdown → shot list),
 * Particl makes it (cast → shots → takes → canvas → delivery). They share
 * the projects, the cast, the engines and the ledger. So the brand at the
 * top-left is not a home button but a product switch: click it and the
 * other room is one item away, the current one marked.
 *
 * Crossing over returns you to the screen you left on that side — a
 * within-visit courtesy kept in session storage, because a week-old "you
 * were on Usage" is noise.
 */
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import AtomikLockup, { AtomikMark } from "@/components/AtomikMark";
import { TRAIL } from "@/components/ParticlMark";

const LAST_PARTICL = "aw_last_particl";
const LAST_ATOMIK = "aw_last_atomik";

export default function BrandSwitch({ side }: { side: "particl" | "atomik" }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const onAtomik = side === "atomik";

  useEffect(() => {
    try { sessionStorage.setItem(path.startsWith("/atomik") ? LAST_ATOMIK : LAST_PARTICL, path); } catch { /* private mode */ }
  }, [path]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  function go(to: "particl" | "atomik") {
    setOpen(false);
    // The current side's item is its front door; the other side's is where you left it.
    if (to === "atomik") {
      if (onAtomik) { router.push("/atomik/ideas"); return; }
      let back = "/atomik/ideas";
      try { back = sessionStorage.getItem(LAST_ATOMIK) || back; } catch { /* private mode */ }
      router.push(back.startsWith("/atomik") ? back : "/atomik/ideas");
      return;
    }
    if (!onAtomik) { router.push("/"); return; }
    let back = "/";
    try { back = sessionStorage.getItem(LAST_PARTICL) || "/"; } catch { /* private mode */ }
    router.push(back.startsWith("/atomik") ? "/" : back);
  }

  return (
    <div ref={wrap} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="brand-switch"
        aria-haspopup="menu" aria-expanded={open}
        title={onAtomik ? "Atomik — switch to Particl" : "Particl — switch to Atomik"}>
        {onAtomik ? <AtomikLockup size={17} /> : (
          <span className="hdr-logo">
            <svg viewBox="30 68 140 64" width="34" height="16" fill="currentColor" aria-hidden="true">
              {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
            </svg>
            <span className="hdr-word">partıcl</span>
          </span>
        )}
        <svg viewBox="0 0 10 14" aria-hidden="true" className="brand-caret">
          <path d="M5 1.5 8 5M5 12.5 8 9M5 1.5 2 5M5 12.5 2 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div role="menu" className="brand-pop">
          <button type="button" role="menuitemradio" aria-checked={!onAtomik} onClick={() => go("particl")} className={`brand-item ${!onAtomik ? "is-on" : ""}`}>
            <svg viewBox="30 68 140 64" width="30" height="14" fill="currentColor" aria-hidden="true">
              {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
            </svg>
            <span className="min-w-0 flex-1">
              <span className="brand-item-name">Particl</span>
              <span className="brand-item-note">Cast, shots, takes, canvas, delivery</span>
            </span>
            <span className={`dot ${!onAtomik ? "dot-picked" : "dot-none"}`} aria-hidden="true" />
          </button>
          <button type="button" role="menuitemradio" aria-checked={onAtomik} onClick={() => go("atomik")} className={`brand-item ${onAtomik ? "is-on" : ""}`}>
            <AtomikMark size={16} />
            <span className="min-w-0 flex-1">
              <span className="brand-item-name">Atomik</span>
              <span className="brand-item-note">Ideas, treatment, breakdown, shot list</span>
            </span>
            <span className={`dot ${onAtomik ? "dot-picked" : "dot-none"}`} aria-hidden="true" />
          </button>
          <span className="brand-pop-note">Same productions, same cast, same ledger — two rooms.</span>
        </div>
      )}
    </div>
  );
}
