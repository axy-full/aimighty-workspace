"use client";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { Tooltip, type TooltipContent } from "./Tooltip";

/**
 * A segmented control (docs/redesign/inventory.md § 3): a sunken track, radius 8, padding 3, the chosen option on the
 * selected fill. One choice of a few, as a radio group: Tab reaches the chosen option, arrow keys move the choice.
 */
export type SegmentOption<T extends string> = { id: T; label: ReactNode; tooltip?: TooltipContent; disabled?: boolean };

export function Segment<T extends string>({ options, value, onChange, label, size = "md" }: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** The group's accessible name. */
  label: string;
  size?: "sm" | "md";
}) {
  const track = useRef<HTMLDivElement>(null);
  const enabled = options.filter((o) => !o.disabled);
  const move = (event: KeyboardEvent, current: T) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const edge = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : null;
    if (!step && edge === null) return;
    event.preventDefault();
    const at = enabled.findIndex((o) => o.id === current);
    const next = enabled[edge ?? (at + step + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.id);
    track.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
  };
  return (
    <div ref={track} role="radiogroup" aria-label={label} className="v12-seg" data-size={size}>
      {options.map((o) => {
        const on = o.id === value;
        const button = (
          <button key={o.id} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={o.disabled}
            className="v12-seg-btn" data-id={o.id} onClick={() => onChange(o.id)} onKeyDown={(e) => move(e, o.id)}>
            {o.label}
          </button>
        );
        return o.tooltip ? <Tooltip key={o.id} {...o.tooltip}>{button}</Tooltip> : button;
      })}
    </div>
  );
}
