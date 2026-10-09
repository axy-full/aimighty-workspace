"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { personLine, workspaceLine } from "@/lib/shell/person";
import { signOut } from "@/lib/shell/sign-out";
import { useScopedFetch } from "@/lib/useScopedFetch";

type Item = { id: string; label: string; run: () => void };

/**
 * Settings behind the avatar (README § 1; the master's account menu): who you are, the workspace and your role,
 * then Team · Plan & credits · Spending rules · Connections · Advanced · Sign out. Settings in five sections is D1;
 * until then each item opens the page that holds it today — Workspace's People, Plans & credits and Engines tabs,
 * and Atomik's Budget and Tools & connections.
 */
export function SettingsMenu({ anchor, onClose }: { anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const shell = useShell();
  const session = useSession();
  const scopedFetch = useScopedFetch();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setAt({ top: Math.round(rect.bottom + 8), right: Math.max(12, Math.round(window.innerWidth - rect.right)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => { menu.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus(); }, []);
  const close = () => { onClose(); anchor.current?.focus(); };
  const go = (run: () => void) => () => { onClose(); run(); };
  const items: Item[] = [
    { id: "team", label: "Team", run: go(() => shell.goWorkspace("people")) },
    { id: "credits", label: "Plan & credits", run: go(() => shell.goWorkspace("credits")) },
    { id: "rules", label: "Spending rules", run: go(() => shell.goSuite("atomik", "budget")) },
    { id: "connections", label: "Connections", run: go(() => shell.goSuite("atomik", "skills")) },
    { id: "advanced", label: "Advanced", run: go(() => shell.goWorkspace("engines")) },
    {
      id: "sign-out", label: busy ? "Signing out…" : "Sign out", run: () => {
        if (busy) return;
        setBusy(true); setProblem("");
        void signOut(scopedFetch).then((why) => { if (why) { setProblem(why); setBusy(false); } });
      },
    },
  ];
  /* ↑/↓ walk the items, Home/End jump, Escape closes back onto the avatar, Tab leaves (and closes). */
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"));
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); all[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); all[all.length - 1]?.focus(); }
    else if (e.key === "Tab") onClose();
  };
  const style = at ? ({ "--menu-top": `${at.top}px`, "--menu-right": `${at.right}px` } as React.CSSProperties) : undefined;
  /* Out of the header, which clips to its 56px: the veil is fixed to the viewport, so it mounts on the shell root. */
  return createPortal(
    <div className="gx-settings-veil" onClick={close} data-testid="settings-veil">
      <div ref={menu} className="gx-settings-menu" role="menu" aria-label="Settings" style={style} onClick={(e) => e.stopPropagation()} onKeyDown={onKey} data-testid="settings-menu">
        <div className="gx-settings-who">
          <span className="gx-settings-name">{personLine(session)}</span>
          <span className="gx-settings-meta">{workspaceLine(session.workspace?.name, session.role)}</span>
        </div>
        <div className="gx-settings-rule" role="separator" />
        {items.map((item) => (
          <button key={item.id} type="button" role="menuitem" className="gx-settings-item" disabled={item.id === "sign-out" && busy} onClick={item.run} data-testid={`settings-${item.id}`}>
            {item.label}
          </button>
        ))}
        {problem ? <p className="gx-settings-problem" role="alert">{problem}</p> : null}
      </div>
    </div>,
    document.querySelector(".gx") ?? document.body,
  );
}
