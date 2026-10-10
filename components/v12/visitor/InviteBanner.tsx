"use client";
import { useJoin } from "@/components/v12/join/JoinProvider";
import { inviteBanner } from "@/components/v12/join/join-model";

/** The slim banner under the header for an invite link (docs/redesign/inventory.md § 8.4): who invited, and the next step. */
export function InviteBanner({ compact }: { compact: boolean }) {
  const join = useJoin();
  const banner = inviteBanner(join?.invite ?? null);
  if (!join || !banner) return null;
  return (
    <div className="v12-vbanner" role="status" data-compact={compact ? "" : undefined} data-testid="v12-invite-banner">
      <span className="v12-vbanner-dot" aria-hidden="true" />
      <span className="v12-vbanner-line">{banner.line}</span>
      <button type="button" className="v12-vbanner-btn" onClick={() => join.openJoin(banner.to === "request" ? "request" : "start")} data-testid="v12-invite-banner-action">{banner.action}</button>
    </div>
  );
}
