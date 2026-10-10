"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "@/lib/workspace/state";
import type { SettingsFold } from "@/lib/shell/settings";

/**
 * The master's Settings grammar (Particl Suites.dc.html › settingsVals): a section is an eyebrow with
 * a meta line, hairline rows (a name and its line, a mono value, an outlined action), at most one
 * filled action, and folds that open with Show and close with Hide.
 */

export function Section({ label, meta, children, action, testId }: {
  label: string; meta?: ReactNode; children?: ReactNode; action?: ReactNode; testId?: string;
}) {
  const id = useId();
  return (
    <section className="gs-sec" aria-labelledby={id} data-testid={testId}>
      <div className="gs-sec-head">
        <h2 className="gs-eyebrow" id={id}>{label}</h2>
        {meta ? <span className="gs-meta">{meta}</span> : null}
      </div>
      {children ? <div className="gs-rows">{children}</div> : null}
      {action ? <div className="gs-sec-act">{action}</div> : null}
    </section>
  );
}

/** A folded section: closed it is its head and Show; open, its rows and Hide (the master's `fold()`). */
export function Fold({ label, meta, open, onToggle, children, testId }: {
  label: string; meta?: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; testId?: string;
}) {
  const id = useId();
  return (
    <section className="gs-sec" aria-labelledby={id} data-testid={testId} data-open={open || undefined}>
      <div className="gs-sec-head">
        <h2 className="gs-eyebrow" id={id}>{label}</h2>
        {meta ? <span className="gs-meta">{meta}</span> : null}
      </div>
      {open ? <div className="gs-rows" id={`${id}-body`}>{children}</div> : null}
      <button type="button" className="gs-fold" aria-expanded={open} aria-controls={open ? `${id}-body` : undefined} onClick={onToggle} data-testid={testId ? `${testId}-toggle` : undefined}>
        {open ? "Hide" : "Show"}<span className="gs-sr"> {label}</span>
      </button>
    </section>
  );
}

export function Row({ name, line, value, valueTitle, accent, children, testId }: {
  name: ReactNode; line?: ReactNode; value?: ReactNode; valueTitle?: string | null; accent?: boolean; children?: ReactNode; testId?: string;
}) {
  return (
    <div className="gs-row" data-testid={testId}>
      <span className="gs-row-k">
        <span className="gs-row-name">{name}</span>
        {line ? <span className="gs-row-line">{line}</span> : null}
      </span>
      {value != null && value !== "" ? <span className="gs-row-v" title={valueTitle ?? undefined} data-accent={accent || undefined}>{value}</span> : null}
      {children ? <span className="gs-row-acts">{children}</span> : null}
    </div>
  );
}

/** An outlined row action; `hot` is the master's accent variant for the next thing to do. */
export function Btn({ children, onClick, hot, danger, disabled, title, testId, pressed }: {
  children: ReactNode; onClick: () => void; hot?: boolean; danger?: boolean; disabled?: boolean; title?: string; testId?: string; pressed?: boolean;
}) {
  return (
    <button type="button" className="gs-btn" data-hot={hot || undefined} data-danger={danger || undefined} disabled={disabled} title={title}
      aria-pressed={pressed} onClick={onClick} data-testid={testId}>
      {children}
    </button>
  );
}

/** A row action that opens an existing page (the one place a password or a plan is changed). */
export function LinkBtn({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  return <a className="gs-btn" href={href} data-testid={testId}>{children}</a>;
}

/** What a read could not do, and Try again (a read failure never says Retry: that is a paid re-render). */
export function Problem({ text, onRetry, testId }: { text: string; onRetry?: () => void; testId?: string }) {
  return (
    <p className="gs-problem" role="alert" data-testid={testId}>
      <span>{text}</span>
      {onRetry ? <button type="button" className="gs-btn" onClick={onRetry}>Try again</button> : null}
    </p>
  );
}

export function Note({ ok, text, testId }: { ok: boolean; text: string; testId?: string }) {
  return <p className={ok ? "gs-note" : "gs-problem"} role={ok ? "status" : "alert"} data-testid={testId}>{text}</p>;
}

/** A fold whose open state starts from the address (`open=`), then follows the person. */
export function Folded({ name, open, label, meta, children }: { name: SettingsFold; open: SettingsFold | null; label: string; meta?: ReactNode; children: ReactNode }) {
  const [shown, setShown] = useState(open === name);
  return <Fold label={label} meta={meta} open={shown} onToggle={() => setShown((v) => !v)} testId={`settings-fold-${name}`}>{children}</Fold>;
}

/** A line of text or code to copy: the setup steps and the server address. */
export function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const { toast } = useWorkspace();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); toast("Copy didn’t work here. Select the text and copy it."); }
  };
  return (
    <div className="gs-copy" data-testid={testId}>
      <span className="gs-row-line">{label}</span>
      <div className="gs-copy-body">
        <pre className="gs-pre">{text}</pre>
        <button type="button" className="gs-btn" onClick={() => void copy()} aria-label={`Copy: ${label.replace(/^\d+\.\s*/, "")}`}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}
