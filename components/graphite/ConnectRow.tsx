"use client";
import { useEffect, useState } from "react";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * Workspace › Engines: the way in for assistants, scripts and MCP clients.
 * Their API tokens act as the person who made them and spend on this
 * workspace; /connect is where one is made (with a monthly ceiling), revoked,
 * and pointed at each client. Nothing linked to it, so a leaked token could
 * only be revoked by someone who knew the URL. The count is here so a token
 * nobody remembers making is noticed.
 */
export function ConnectRow() {
  const scoped = useScopedFetch();
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    let on = true;
    scoped("/api/tokens", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { tokens?: unknown[] } | null) => { if (on) setLive(Array.isArray(json?.tokens) ? json.tokens.length : null); })
      .catch(() => {});
    return () => { on = false; };
  }, [scoped]);
  const line = live == null ? "Make, cap and revoke tokens" : live === 0 ? "No tokens yet · make one" : `${live} live ${live === 1 ? "token" : "tokens"} · make, cap or revoke`;
  return (
    <div className="gx-card" data-testid="engine-connect">
      <span className="gx-eyebrow">Assistants &amp; API tokens</span>
      <a className="gx-rowlink" href="/connect" data-testid="workspace-connect-link">
        <span>{line}</span>
        <span aria-hidden="true" style={{ color: "var(--gx-text-3)" }}>›</span>
      </a>
      <p className="cw-foot" style={{ padding: 0 }}>A token renders as you and spends on this workspace, up to its monthly ceiling.</p>
    </div>
  );
}
