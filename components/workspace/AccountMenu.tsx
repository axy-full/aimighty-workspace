"use client";
import { useEffect, useRef, useState } from "react";
import { clearPrivateLocal, useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { initialsOf } from "@/lib/workspace/format";
import { useWorkspace } from "@/lib/workspace/state";
import { legacyShellHref } from "@/lib/workspace/switchover";
import type { WorkspaceAccount } from "@/lib/workspace/data";

/* ──────────────────────────────────────────────────────────────────────────
   The account menu, for the surface that is now the default.

   Every destination below already exists and keeps its own route — this menu
   is the missing way IN to them from the new shell (switch-over requirement
   4). The old shell reaches them from components/workbench/WorkspaceMenu.tsx;
   that component is left where it is, styled by the old stylesheets.

   A <details> element, so it opens before hydration and closes on Escape
   without a focus-trap library.
   ────────────────────────────────────────────────────────────────────────── */

/** Pages the new shell has no page of its own for. Each keeps its old route. */
const ELSEWHERE: { href: string; label: string; note: string }[] = [
  { href: "/library?all=1", label: "All assets", note: "Every upload and generation, across projects" },
  { href: "/generate", label: "Gen", note: "The standalone composer" },
  { href: "/productions", label: "Productions", note: "Deliverables and totals" },
  { href: "/pipelines", label: "Pipelines", note: "Saved pipelines and their runs" },
];

const ACCOUNT: { href: string; label: string }[] = [
  { href: "/settings", label: "Workspace & account" },
  { href: "/team", label: "Team" },
  { href: "/billing", label: "Credits & plan" },
  { href: "/usage", label: "Usage" },
];

export function AccountMenu({ account }: { account: WorkspaceAccount | null }) {
  const session = useSession();
  const { state } = useWorkspace();
  const scopedFetch = useScopedFetch();
  const box = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && box.current?.open) box.current.open = false;
    };
    const outside = (event: MouseEvent) => {
      const el = box.current;
      if (el?.open && event.target instanceof Node && !el.contains(event.target)) el.open = false;
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", outside);
    };
  }, []);

  /** The same two calls the old menu makes, with the same captured scope. */
  const change = async (action: "switch" | "logout", id?: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await scopedFetch(action === "switch" ? "/api/workspaces/switch" : "/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "switch" ? { id } : {}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Your account could not be changed. Please try again.");
      }
      clearPrivateLocal();
      /* A switch lands back on this surface; signing out leaves it. */
      window.location.assign(action === "switch" ? "/workspace" : "/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your account could not be changed. Please try again.");
      setBusy(false);
    }
  };

  const name = account?.workspace?.name ?? session.workspace?.name ?? session.name ?? "Workspace";
  const current = account?.workspace?.id ?? session.workspace?.id ?? null;
  const others = session.workspaces ?? [];

  return (
    <details className="pxw-account" ref={box} data-testid="workspace-account">
      <summary className="pxw-account-summary" data-testid="workspace-account-open" aria-label={`Account and workspace: ${name}`}>
        <span className="pxw-avatar" aria-hidden="true">{initialsOf(name)}</span>
        <span className="pxw-account-caret" aria-hidden="true">▾</span>
      </summary>
      <div className="pxw-account-menu" role="menu">
        <div className="pxw-account-identity">
          <strong>{session.name ?? name}</strong>
          <small>{name}{session.role ? ` · ${session.role}` : ""}</small>
        </div>
        {error ? <p className="pxw-account-error" role="alert">{error}</p> : null}

        <p className="pxw-account-kicker">ACCOUNT</p>
        {ACCOUNT.map((item) => (
          <a key={item.href} className="pxw-account-item" role="menuitem" href={item.href}>{item.label}</a>
        ))}

        <p className="pxw-account-kicker">ELSEWHERE IN PARTICL</p>
        {ELSEWHERE.map((item) => (
          <a key={item.href} className="pxw-account-item" role="menuitem" href={item.href}>
            <span>{item.label}</span>
            <small>{item.note}</small>
          </a>
        ))}

        {others.length > 1 ? (
          <>
            <p className="pxw-account-kicker">SWITCH WORKSPACE</p>
            {others.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                role="menuitem"
                className="pxw-account-item"
                disabled={busy || workspace.id === current}
                aria-current={workspace.id === current ? "true" : undefined}
                onClick={() => void change("switch", workspace.id)}
              >
                <span>{workspace.name}</span>
                <small>{workspace.role}</small>
              </button>
            ))}
          </>
        ) : null}
        <a className="pxw-account-item" role="menuitem" href="/billing?workspace=new">Create a workspace</a>

        {/* The switch-over escape hatch. One release; see
            docs/workspace-switchover.md for when it comes out. */}
        <p className="pxw-account-kicker">THIS RELEASE</p>
        <a
          className="pxw-account-item pxw-account-item--legacy"
          role="menuitem"
          href={legacyShellHref(state)}
          data-testid="legacy-shell-link"
        >
          <span>Use the previous workspace</span>
          <small>The old studio, with this project and page</small>
        </a>

        <button type="button" role="menuitem" className="pxw-account-item" disabled={busy} onClick={() => void change("logout")}>
          Sign out
        </button>
      </div>
    </details>
  );
}
