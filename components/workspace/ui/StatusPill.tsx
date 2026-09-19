export type Status = "approved" | "ready" | "queued" | "draft" | "review" | "source" | "failed";

/** Chip = 6px dot + label, padding 3px 9px, radius 7px, tinted background. */
export const STATUS: Record<Status, { label: string; dot: string; color: string; bg: string }> = {
  approved: { label: "Approved", dot: "var(--pxw-green)", color: "var(--pxw-green-ink)", bg: "var(--pxw-green-tint)" },
  ready: { label: "Ready", dot: "var(--pxw-blue)", color: "var(--pxw-blue-soft-ink)", bg: "rgba(10,132,255,.14)" },
  queued: { label: "Queued", dot: "var(--pxw-amber)", color: "var(--pxw-amber-ink)", bg: "rgba(255,159,10,.13)" },
  draft: { label: "Draft", dot: "var(--pxw-neutral-state)", color: "var(--pxw-muted)", bg: "rgba(255,255,255,.05)" },
  review: { label: "Review", dot: "var(--pxw-amber)", color: "var(--pxw-amber-ink)", bg: "rgba(255,159,10,.13)" },
  source: { label: "Source", dot: "var(--pxw-neutral-state)", color: "var(--pxw-muted)", bg: "rgba(255,255,255,.05)" },
  /* Product rule: failed generations are not billed, and say so. */
  failed: { label: "Failed · not billed", dot: "var(--pxw-red)", color: "var(--pxw-red-ink)", bg: "var(--pxw-red-tint)" },
};

export function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span className="pxw-pill" style={{ background: s.bg }} data-status={status}>
      <span className="pxw-dot" style={{ background: s.dot }} />
      <span className="pxw-pill-label" style={{ color: s.color }}>{s.label}</span>
    </span>
  );
}
