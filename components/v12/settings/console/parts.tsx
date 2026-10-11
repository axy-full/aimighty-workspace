"use client";
import type { ReactNode } from "react";

/** The console's small pieces (components/v12/settings/console/console.css): a section, a row, a switch, a note. */

export function Sec({ label, meta, children, testId }: { label?: string; meta?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <section className="v12-ws-sec" data-testid={testId}>
      {label || meta ? (
        <div className="v12-ws-sec-head">
          {label ? <h2 className="v12-ws-eyebrow">{label}</h2> : <span />}
          {meta ? <span className="v12-ws-meta">{meta}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Row({ name, line, value, children, testId }: { name: ReactNode; line?: ReactNode; value?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="v12-ws-row" data-testid={testId}>
      <span className="v12-ws-row-k">
        <span>{name}</span>
        {line ? <span className="v12-ws-row-line">{line}</span> : null}
      </span>
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>{value != null && value !== "" ? <span className="v12-ws-mono">{value}</span> : null}{children}</span>
    </div>
  );
}

export function Switch({ on, onChange, name, state, line, disabled, title, testId }: { on: boolean; onChange: (next: boolean) => void; name: string; state?: string; line?: ReactNode; disabled?: boolean; title?: string; testId?: string }) {
  return (
    <div className="v12-ws-switch" data-testid={testId}>
      <button type="button" role="switch" aria-checked={on} aria-label={name} className="v12-ws-sw" disabled={disabled} title={title} onClick={() => onChange(!on)} data-testid={testId ? `${testId}-switch` : undefined}>
        <span className="v12-ws-sw-track" aria-hidden="true"><span className="v12-ws-sw-knob" /></span>
      </button>
      <span className="v12-ws-sw-k">
        <span className="v12-ws-sw-name">{name}{state ? <span className="v12-ws-mono v12-ws-quiet" style={{ fontSize: 12, fontWeight: 500 }}>{state}</span> : null}</span>
        {line ? <span className="v12-ws-row-line">{line}</span> : null}
      </span>
    </div>
  );
}

export function Note({ ok, text, testId }: { ok: boolean; text: string; testId?: string }) {
  return <div className="v12-ws-note" data-ok={ok} role={ok ? "status" : "alert"} data-testid={testId}>{text}</div>;
}

export function Problem({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="v12-ws-note" data-ok={false} role="alert" style={{ display: "flex", gap: 12, alignItems: "center" }}>
      {text}
      {onRetry ? <button type="button" className="v12-ws-btn" onClick={onRetry}>Try again</button> : null}
    </div>
  );
}

/** "AP": initials of a name, two letters at most. */
export const initialsOf = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
