"use client";
import Link from "next/link";
import { useState } from "react";
import { TRAIL } from "@/components/ui/Mark";
import "@/components/graphite/shell.css";
import "./fault.css";

/**
 * A signed-in account that is in no workspace yet (a verified account whose first workspace is still being made, or one
 * that left its last). The shell has nothing to open for it, so it says so and offers the two things the code supports:
 * make a workspace (/billing?new=1, which asks for a name and provisions it) or sign out. Plain: no suites, no project.
 *
 * Sign-out carries the account's own scope (the one the old surface used for this account), because there is no
 * workspace scope to send.
 */
export function NoWorkspace({ scope, email }: { scope: string; email?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope }, body: "{}" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "You could not be signed out. Try again.");
      window.location.assign("/login");
    } catch (cause) {
      setProblem(cause instanceof Error && cause.message ? cause.message : "You could not be signed out. Try again.");
      setBusy(false);
    }
  };
  return (
    <div className="gx gx-outside" data-view="suite" data-suite="studio" data-testid="no-workspace">
      <header className="gx-header" data-row="header" data-static="true" data-member="false">
        <Link className="gx-brand" href="/" aria-label="particl home">
          <svg width="30" height="14" viewBox="30 68 140 64" fill="currentColor" aria-hidden="true">
            {TRAIL.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} />)}
          </svg>
          <span className="gx-brand-name">particl</span>
        </Link>
        <span className="gx-spacer" />
      </header>
      <main className="gx-outside-body">
        <section className="gx-fault" aria-labelledby="gx-nw-title" data-fault="no-workspace">
          <h1 className="gx-fault-title" id="gx-nw-title" data-testid="no-workspace-title">You’re not in a workspace yet</h1>
          <p className="gx-fault-sub">{email ? `${email} is signed in, but it belongs to no workspace.` : "This account belongs to no workspace."} Make one, or ask the person who invited you to send a new link.</p>
          <div className="gx-fault-actions">
            <Link className="gx-primary" href="/billing?new=1" data-testid="no-workspace-create">Create a workspace</Link>
            <button type="button" className="gx-hbtn" disabled={busy} onClick={() => void signOut()} data-testid="no-workspace-sign-out">{busy ? "Signing out…" : "Sign out"}</button>
          </div>
          {problem ? <p className="gx-fault-ref" role="alert" data-testid="no-workspace-problem">{problem}</p> : null}
        </section>
      </main>
    </div>
  );
}
