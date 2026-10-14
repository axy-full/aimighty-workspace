"use client";
import { useId, useRef, useState, type ReactNode } from "react";
import { useSession } from "@/lib/session";
import { creditRate, creditsText, creditsUsd } from "@/lib/shell/price-words";
import { Popover } from "../ui";

/** An amount of credits as the platform's rate card counts them, with its dollar value at the public price of a credit on hover. */
export function Cr({ credits }: { credits: number }) {
  const { rates } = useSession();
  return <span className="v12-pc-mono" title={creditsUsd(credits, creditRate(rates.creditUsd)) ?? undefined}>{creditsText(credits)}</span>;
}

/** A switch with its state in words beside it ("off" / "on"), as the prototype draws the console's switches. */
export function Switch({ on, onChange, label, disabled, title, testId }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; title?: string; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} title={title} className="v12-pc-switch" data-on={on || undefined} data-testid={testId} onClick={() => onChange(!on)}>
      <span className="v12-pc-switch-knob" aria-hidden />
      <span className="v12-sr">{label}</span>
    </button>
  );
}

export type PickerOption = { id: string; label: string; detail?: ReactNode; group?: string; note?: string };

/**
 * A choice among a few, in a popover: the chosen option's label and detail on the button, the others grouped under their
 * headings. ↑/↓ move, Enter chooses, Esc closes (the popover's own).
 */
export function Picker({ value, options, onChange, label, testId, disabled }: { value: string; options: readonly PickerOption[]; onChange: (id: string) => void; label: string; testId?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = options.find((o) => o.id === value);
  const groups: { name: string | null; items: PickerOption[] }[] = [];
  for (const o of options) {
    const name = o.group ?? null;
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.items.push(o); else groups.push({ name, items: [o] });
  }
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
    const at = all.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => { event.preventDefault(); all[(i + all.length) % all.length]?.focus(); };
    if (event.key === "ArrowDown") go(at + 1); else if (event.key === "ArrowUp") go(at < 0 ? all.length - 1 : at - 1);
  };
  return (
    <>
      <button ref={anchor} type="button" className="v12-pc-picker" aria-haspopup="listbox" aria-expanded={open} aria-label={label} disabled={disabled} data-testid={testId} onClick={() => setOpen((v) => !v)}>
        <span className="v12-pc-picker-label">{current?.label ?? value}</span>
        {current?.detail ? <span className="v12-pc-picker-detail">{current.detail}</span> : null}
        {!current ? <span className="v12-pc-picker-detail">no working key</span> : null}
        <span className="v12-pc-picker-caret" aria-hidden>▾</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} role="dialog" width={360} className="v12-pc-pop" onKeyDown={move} testId={testId ? `${testId}-list` : undefined}>
        <div role="listbox" id={listId} aria-label={label}>
          {groups.map((g) => (
            <div key={g.name ?? "_"} className="v12-pc-pop-group">
              {g.name ? <div className="v12-pc-pop-head">{g.name}</div> : null}
              {g.items.map((o) => (
                <button key={o.id} type="button" role="option" aria-selected={o.id === value} className="v12-pc-pop-opt" data-id={o.id} onClick={() => { setOpen(false); if (o.id !== value) onChange(o.id); }}>
                  <span className="v12-pc-pop-name">{o.label}</span>
                  {o.detail ? <span className="v12-pc-pop-detail">{o.detail}</span> : null}
                </button>
              ))}
            </div>
          ))}
          {!options.length ? <div className="v12-pc-pop-empty">Nothing with a working key.</div> : null}
        </div>
      </Popover>
    </>
  );
}

/** The section's header: the eyebrow, the title and its one sentence. */
export function Head({ title, line, children }: { title: string; line?: string; children?: ReactNode }) {
  return (
    <header className="v12-pc-head">
      <div className="v12-pc-eyebrow">Platform console</div>
      <div className="v12-pc-headrow">
        <h1 className="v12-pc-h1">{title}</h1>
        {children}
      </div>
      {line ? <p className="v12-pc-line">{line}</p> : null}
    </header>
  );
}

/** "17 Oct": the console's one way to write a day. */
export const day = (at: number): string => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
