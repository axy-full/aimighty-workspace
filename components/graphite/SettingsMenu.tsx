"use client";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { personLine, workspaceLine } from "@/lib/shell/person";
import { signOut } from "@/lib/shell/sign-out";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { switchWorkspace, useSwitchState } from "@/lib/shell/switch-workspace";
import { useRigDrain } from "@/components/workspace/rig/RigProvider";
import { useOptionalToast } from "@/lib/workspace/state";
import { useGoSettings } from "./settings/navigate";

type Item = { id: string; label: string; run: () => void };

/**
 * Settings behind the avatar (README § 1; the master's account menu): who you are, the workspace and your role,
 * then Team · Plan & credits · Spending rules · Connections · Advanced · Sign out.
 *
 * With the new interface on, each item opens its Settings section (components/graphite/settings/), or the page
 * that holds it today while that section is not drawn yet (lib/shell/settings.ts); switching to another of your
 * workspaces and the platform desk move here from Workspace's General tab. With it off, each item opens the page
 * that holds it today — Workspace's People, Plans & credits and Engines tabs, and Atomik's Budget and Tools &
 * connections — as before.
 */
export function SettingsMenu({ anchor, onClose }: { anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const shell = useShell();
  const session = useSession();
  const scopedFetch = useScopedFetch();
  const goSettings = useGoSettings();
  const drain = useRigDrain();
  const [signingOut, setSigningOut] = useState(false);
  /* A switch running, from this menu or one opened before it: the workspace being switched to, while the board's last
     edit saves and the route answers. Sign out and every switch wait for it. */
  const sw = useSwitchState();
  const switching = sw.phase === "idle" ? null : sw.id;
  const busy = signingOut || switching !== null;
  /* A switch that did not happen after the menu was closed says why in the shell's toast instead. */
  const toast = useOptionalToast();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
  const current = session.workspace?.id ?? null;
  const others = (session.workspaces ?? []).filter((w) => w.id !== current);
  /* Another of your workspaces (lib/shell/switch-workspace.ts): the board's last edit saved first, then the route, then the shell from the top. */
  const switchTo = (id: string) => async () => {
    if (busy) return;
    setProblem("");
    const why = await switchWorkspace({ id, fetch: scopedFetch, drain, go: () => window.location.assign("/suites") });
    if (!why) return;
    if (mounted.current) {
      setProblem(why);
      /* Back into the menu once the page is live again, so Escape and the arrows work. */
      setTimeout(() => menu.current?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus(), 0);
    } else toast?.(why);
  };
  const items: Item[] = [
    { id: "team", label: "Team", run: go(() => goSettings("team")) },
    { id: "credits", label: "Plan & credits", run: go(() => goSettings("credits")) },
    { id: "rules", label: "Spending rules", run: go(() => goSettings("rules")) },
    { id: "connections", label: "Connections", run: go(() => goSettings("connections")) },
    { id: "advanced", label: "Advanced", run: go(() => goSettings("advanced")) },
    ...others.map((w) => ({ id: `switch-${w.id}`, label: switching === w.id ? `Switching to ${w.name}…` : `Switch to ${w.name}`, run: () => void switchTo(w.id)() })),
    ...(session.superAdmin ? [{ id: "platform-desk", label: "Platform desk", run: () => { onClose(); window.location.assign("/admin"); } }] : []),
    {
      id: "sign-out", label: signingOut ? "Signing out…" : "Sign out", run: () => {
        if (busy) return;
        setSigningOut(true); setProblem("");
        void signOut(scopedFetch).then((why) => { if (why) { setProblem(why); setSigningOut(false); } });
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
          <button key={item.id} type="button" role="menuitem" className="gx-settings-item" disabled={(item.id === "sign-out" || item.id.startsWith("switch-")) && busy} aria-busy={item.id === `switch-${switching}` || undefined} onClick={item.run} data-testid={`settings-${item.id}`}>
            {item.label}
          </button>
        ))}
        {problem ? <p className="gx-settings-problem" role="alert">{problem}</p> : null}
      </div>
    </div>,
    document.querySelector(".gx") ?? document.body,
  );
}
