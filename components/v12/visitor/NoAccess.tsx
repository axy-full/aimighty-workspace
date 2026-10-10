"use client";
import { useJoin } from "@/components/v12/join/JoinProvider";
import { loginPath } from "@/components/v12/join/join-model";
import { NO_ACCESS } from "@/lib/v12/visitor";

/**
 * "You don't have access" (docs/redesign/inventory.md § 8.7): a link to a board that is not the visitor's, shown with
 * nothing of the board in it. A visitor has no workspace, so the page asks the server for nothing: there is nothing
 * to preview, whatever the link says.
 */
export function NoAccess() {
  const join = useJoin();
  const here = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
  return (
    <div className="v12-noaccess" data-testid="v12-no-access">
      <span className="v12-noaccess-lock" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
      </span>
      <h1 className="v12-noaccess-title">{NO_ACCESS.title}</h1>
      <p className="v12-noaccess-line">{NO_ACCESS.line}</p>
      <div className="v12-noaccess-actions">
        <a className="v12-vbtn" href={loginPath(here)} data-testid="v12-no-access-login">Log in</a>
        <button type="button" className="v12-vbtn v12-vbtn-primary" onClick={() => join?.openJoin("request")} data-testid="v12-no-access-request">Request access</button>
      </div>
    </div>
  );
}
