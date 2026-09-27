"use client";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { Fault } from "@/components/Boundary";
import { faultMessage, faultPrimary, faultReport, isStaleBuild } from "@/lib/shell/fault";
import "@/app/fault.css";

/**
 * What a panel shows when it throws (components/Boundary.tsx › fallback), in
 * the shell's own material: the panel's name, one line that says the rest
 * still works, Try again (Reload once trying keeps failing, or when a deploy
 * replaced the code), Copy details, and the ref the console line carries.
 */

export function FaultIcon({ tone = "warn" }: { tone?: "warn" | "info" }) {
  return (
    <span className="gx-fault-icon" data-tone={tone} aria-hidden="true">
      {tone === "warn" ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3.5 21.5 20h-19z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none" /></svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /><path d="M9 11h4" /></svg>
      )}
    </span>
  );
}

/** Copy details: "Copied" for two seconds, or "Copy blocked" when the browser refuses. */
export function CopyDetails({ text, testId = "fault-copy" }: { text: () => string; testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "blocked">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text()); setState("copied"); } catch { setState("blocked"); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className="gx-hbtn" onClick={() => void copy()} data-testid={testId} data-state={state}>
      {state === "copied" ? "Copied" : state === "blocked" ? "Copy blocked" : "Copy details"}
    </button>
  );
}

function where(): string | null {
  return typeof window === "undefined" ? null : window.location.pathname + window.location.search;
}

/**
 * Where focus goes when a card appears. A card is mounted afresh by every
 * failure, so after a Try again that failed the pressed button is gone and
 * focus has fallen back to the page: it goes to the replacement. A card that
 * appears on its own leaves focus where the person is — typing in the
 * composer is never interrupted. A card that is the whole of a dialog the
 * person just opened (Search, Atomik) takes focus, as the dialog would have.
 */
function useFocusOnMount(attempts: number, dialog: boolean) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (dialog || (attempts > 0 && lost)) first.current?.focus();
  }, [attempts, dialog]);
  return first;
}

/**
 * Try again, or Reload once trying has failed twice or a deploy replaced the
 * code. While a retry is on its way it says so and ignores presses; it stays
 * focusable (aria-disabled, not disabled) so the keyboard keeps its place.
 */
function PrimaryAction({ fault, className, button }: { fault: Fault; className: string; button: Ref<HTMLButtonElement> }) {
  if (faultPrimary(fault.error, fault.attempts) === "reload") {
    return <button ref={button} type="button" className={className} onClick={() => window.location.reload()} data-testid="fault-reload">Reload</button>;
  }
  return (
    <button ref={button} type="button" className={className} onClick={() => { if (!fault.pending) fault.retry(); }} aria-disabled={fault.pending || undefined} data-testid="fault-retry">
      {fault.pending ? "Trying…" : "Try again"}
    </button>
  );
}

/**
 * `panel` sits in a stage or a side panel; `inline` is one row for a tile or a
 * strip. `actions` adds the panel's own way out (Close) after the retry.
 */
export function PanelFault({ fault, name, variant = "panel", title, actions, dialog = false }: {
  fault: Fault; name: string; variant?: "panel" | "inline"; title?: string; actions?: ReactNode;
  /** The card is the whole of a dialog the person just opened: it takes focus. */
  dialog?: boolean;
}) {
  const first = useFocusOnMount(fault.attempts, dialog);
  const stale = isStaleBuild(fault.error);
  const retrying = faultPrimary(fault.error, fault.attempts) === "retry";
  const message = faultMessage(fault.error);
  const heading = title ?? `${fault.what} stopped`;
  const report = () => faultReport({ what: fault.what, error: fault.error, where: where() });

  if (variant === "inline") {
    return (
      <div className="gx-fault" data-variant="inline" role="alert" data-testid="panel-fault" data-fault={name} data-attempts={fault.attempts}>
        <FaultIcon />
        <span className="gx-fault-line"><strong>{heading}</strong> <span className="gx-fault-ref-inline" data-testid="fault-ref">ref {fault.ref}</span></span>
        <PrimaryAction fault={fault} className="gx-hbtn" button={first} />
        {actions}
      </div>
    );
  }

  return (
    <div className="gx-fault" data-variant="panel" role="alert" data-testid="panel-fault" data-fault={name} data-attempts={fault.attempts}>
      <FaultIcon />
      <p className="gx-fault-title">{heading}</p>
      <p className="gx-fault-sub">{stale ? "Particl was updated. Reload to carry on." : "Everything else still works. Takes in progress keep generating."}</p>
      <div className="gx-fault-actions">
        <PrimaryAction fault={fault} className="gx-primary" button={first} />
        {retrying && fault.attempts > 0 ? <button type="button" className="gx-hbtn" onClick={() => window.location.reload()} data-testid="fault-reload">Reload</button> : null}
        {actions}
        <CopyDetails text={report} />
      </div>
      <p className="gx-fault-ref" data-testid="fault-ref" title={message ?? undefined}>
        <span>ref {fault.ref}</span>{message ? <span className="gx-fault-msg"> · {message}</span> : null}
      </p>
    </div>
  );
}

/**
 * One take that threw keeps its tile — same size, same place, its name — so
 * the grid does not jump; the whole thumbnail is its Try again.
 */
export function TileFault({ fault, name }: { fault: Fault; name: string }) {
  const first = useFocusOnMount(fault.attempts, false);
  return (
    <div className="gx-asset" data-faulted="true" data-testid="take-fault" role="alert">
      <button ref={first} type="button" className="gx-asset-thumb gx-fault-tile" onClick={() => { if (!fault.pending) fault.retry(); }} aria-disabled={fault.pending || undefined}
        aria-label={`${name} could not be shown. Try again`} title={`ref ${fault.ref}`}>
        <FaultIcon /><span>{fault.pending ? "Trying…" : "Try again"}</span>
      </button>
      <span className="gx-asset-name">{name}</span>
      <span className="gx-asset-meta">ref {fault.ref}</span>
    </div>
  );
}

/**
 * A side panel that threw keeps its frame — same island, same width, same
 * overlay behaviour and Close — so the grid does not jump and the way out is
 * where it always is.
 */
export function FaultAside({ kind, overlay, fault, onClose }: { kind: "library" | "inspector"; overlay: boolean; fault: Fault; onClose?: () => void }) {
  const label = kind === "library" ? "Library" : "Inspector";
  return (
    <aside className={`gx-panel gx-${kind}${overlay ? " gx-panel--overlay" : ""}`} aria-label={label} data-testid={kind} data-faulted="true">
      <div className={kind === "library" ? "gx-panel-head" : "gx-insp-head"}>
        <span className="gx-panel-title">{label}</span>
        {onClose ? (
          kind === "library"
            ? <button type="button" className="gx-hbtn gx-panel-close" onClick={onClose} data-testid="close-library">Close</button>
            : <button type="button" className="gx-hbtn gx-panel-close gx-insp-x" onClick={onClose} aria-label="Hide inspector" data-testid="close-inspector">×</button>
        ) : null}
      </div>
      <div className="gx-fault-host" data-kind={kind}>
        <PanelFault fault={fault} name={kind} />
      </div>
    </aside>
  );
}
