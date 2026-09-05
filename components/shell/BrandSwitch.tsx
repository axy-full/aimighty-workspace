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
import { useSession } from "@/lib/session";
import { appAlert, appPrompt } from "@/components/dialog";

const LAST_PARTICL = "aw_last_particl";
const LAST_ATOMIK = "aw_last_atomik";

export default function BrandSwitch({ side }: { side: "particl" | "atomik" }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const onAtomik = side === "atomik";
  const { signedIn, workspace, workspaces } = useSession();
  const [switching, setSwitching] = useState(false);

  /* Every workspace has its own database, so moving between them is a
     server-side change of the session, followed by a fresh page. */
  async function switchTo(id: string) {
    if (id === workspace?.id) { setOpen(false); return; }
    setSwitching(true);
    try {
      const res = await fetch("/api/workspaces/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Couldn't switch");
      try { localStorage.removeItem("aw_project"); } catch { /* private mode */ }
      window.location.assign(onAtomik ? "/atomik/ideas" : "/");
    } catch (e) { setSwitching(false); await appAlert("Not switched", (e as Error).message); }
  }
  async function create() {
    setOpen(false);
    const name = await appPrompt("Name the new workspace", "", "A studio, a client, a project");
    if (!name?.trim()) return;
    const res = await fetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { await appAlert("Not created", json.error ?? `The server answered ${res.status}.`); return; }
    await switchTo(json.workspace.id);
  }

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
          {signedIn && (
            <>
              <span className="brand-pop-h">Workspaces</span>
              {workspaces.map((w) => (
                <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === workspace?.id} disabled={switching}
                  className={`brand-item !py-2 ${w.id === workspace?.id ? "is-on" : ""}`} onClick={() => switchTo(w.id)}>
                  <span className="min-w-0 flex-1">
                    <span className="brand-item-name !text-[13px]">{w.name}</span>
                    <span className="brand-item-note">{w.role === "owner" ? "Owner" : w.role === "admin" ? "Admin" : "Member"}</span>
                  </span>
                  <span className={`dot ${w.id === workspace?.id ? "dot-picked" : "dot-none"}`} aria-hidden="true" />
                </button>
              ))}
              {workspaces.length === 0 && <span className="brand-pop-note !border-0 !mt-0">You&rsquo;re not on a workspace yet.</span>}
              <button type="button" role="menuitem" className="brand-item !py-2" onClick={create}>
                <span className="min-w-0 flex-1"><span className="brand-item-name !text-[13px] text-dim">+ New workspace</span></span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
