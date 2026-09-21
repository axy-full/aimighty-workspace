"use client";
import { useState } from "react";
import { WORKSPACE_TABS } from "@/lib/shell/ia";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { creditsLabel } from "@/lib/workspace/format";
import type { WorkspaceAccount } from "@/lib/workspace/data";
import { XaiEngineRow } from "./crew/XaiEngineRow";

/**
 * Workspace: General · People · Plans & credits · Usage · Engines · Security
 * (max-width 1040). Until build step 6 rebuilds each tab in Graphite, every
 * tab opens the page that already does the job — nothing here is a stub.
 */
const ROWS: Record<string, { label: string; href: string }[]> = {
  general: [{ label: "Workspace name, delivery defaults and cost approval", href: "/settings" }, { label: "All assets, across projects", href: "/library?all=1" }],
  people: [{ label: "Members, roles and invitations", href: "/team" }],
  credits: [{ label: "Plans, packs and statements", href: "/billing" }],
  usage: [{ label: "Usage by engine, settled only", href: "/usage" }],
  engines: [{ label: "Engine connections and keys", href: "/settings#engines" }],
  security: [{ label: "Sessions, password and two-step sign-in", href: "/account/security" }],
};

export function WorkspaceView({ account }: { account: WorkspaceAccount | null }) {
  const shell = useShell();
  const session = useSession();
  const scopedFetch = useScopedFetch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const credits = creditsLabel(account?.credits?.balance ?? null, session.rates.unit, session.rates.creditUsd);
  const change = async (action: "switch" | "logout", id?: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const response = await scopedFetch(action === "switch" ? "/api/workspaces/switch" : "/api/auth/logout", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "switch" ? { id } : {}),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Your account could not be changed. Please try again.");
      window.location.assign(action === "switch" ? "/suites" : "/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your account could not be changed. Please try again.");
      setBusy(false);
    }
  };
  const current = account?.workspace?.id ?? session.workspace?.id ?? null;
  const others = (session.workspaces ?? []).filter((w) => w.id !== current);
  return (
    <div className="gx-ws gx-scroll" data-testid="workspace-view">
      <div className="gx-ws-inner gx-enter">
        <h1 className="gx-h1">Workspace</h1>
        <div className="gx-seg" role="tablist" aria-label="Workspace sections" style={{ alignSelf: "flex-start", maxWidth: "100%", overflowX: "auto" }}>
          {WORKSPACE_TABS.map((t) => (
            <button key={t.id} type="button" role="tab" className="gx-seg-btn" aria-selected={shell.wsTab === t.id} onClick={() => shell.goWorkspace(t.id)}><span>{t.label}</span></button>
          ))}
        </div>
        {shell.wsTab === "credits" ? (
          <div className="gx-card">
            <span className="gx-eyebrow">Balance</span>
            <span className="gx-balance" title={credits.title} data-testid="workspace-balance">{credits.text}</span>
          </div>
        ) : null}
        <div className="gx-card">
          <span className="gx-eyebrow">{WORKSPACE_TABS.find((t) => t.id === shell.wsTab)?.label}</span>
          {ROWS[shell.wsTab].map((row) => (
            <a key={row.href} className="gx-rowlink" href={row.href}><span>{row.label}</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></a>
          ))}
        </div>
        {shell.wsTab === "engines" ? <XaiEngineRow /> : null}
        {shell.wsTab === "general" ? (
          <div className="gx-card">
            <span className="gx-eyebrow">{account?.workspace?.name ?? session.workspace?.name ?? "Workspace"}{session.role ? ` · ${session.role}` : ""}</span>
            {error ? <p role="alert" style={{ margin: 0, color: "var(--gx-failed)" }}>{error}</p> : null}
            {others.map((w) => (
              <button key={w.id} type="button" className="gx-rowlink" disabled={busy} onClick={() => change("switch", w.id)}><span>Switch to {w.name}</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></button>
            ))}
            <button type="button" className="gx-rowlink" disabled={busy} onClick={() => change("logout")} data-testid="sign-out"><span>Sign out</span><span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span></button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
