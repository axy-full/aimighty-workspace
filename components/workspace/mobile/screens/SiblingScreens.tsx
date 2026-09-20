"use client";
import { formatCredits } from "@/lib/workspace/format";
import type { WorkspaceAccount } from "@/lib/workspace/data";

/**
 * Make (the unfiled wall, M4) and Settings (M10) are siblings of the
 * drill-down, reachable from the dock and the avatar. Wave M-B builds Make and
 * wave M-C builds Settings; the shell already routes to them, so what they
 * render here is one honest line and, for Settings, the balance the header
 * already knows. No fixtures, no placeholder wall, no loader.
 */
export function MakeScreen() {
  return (
    <div className="pxm-pad" data-screen="make">
      <div className="pxm-kicker" data-functional-label="">UNFILED</div>
      <p className="pxm-note" data-testid="mobile-make-pending">
        The unfiled wall — every take that has not been filed to a shot — opens here with the composer docked above the
        primary. It arrives with the Make screen.
      </p>
    </div>
  );
}

export function SettingsScreen({ account }: { account: WorkspaceAccount | null }) {
  return (
    <div className="pxm-pad" data-screen="settings">
      <div className="pxm-card">
        <div className="pxm-kicker" data-functional-label="">CREDITS</div>
        <div className="pxm-balance" data-testid="mobile-settings-balance">
          {account?.credits ? formatCredits(account.credits.balance) : "—"}
        </div>
        {account?.workspace ? <div className="pxm-project-meta">{account.workspace.name}</div> : null}
      </div>
      <p className="pxm-note" data-testid="mobile-settings-pending">
        Top-up, workspace, team and Atomik’s three rules open here with the Settings screen.
      </p>
    </div>
  );
}
