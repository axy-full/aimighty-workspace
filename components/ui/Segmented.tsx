"use client";

import type { ReactNode } from "react";

/**
 * Segmented control (design/particl-v2/README.md §3; board 7a): a `--card`
 * pill with a 1px `--border` edge and 2px of padding, 2px between options;
 * each option a 999 pill in Outfit 500 13px, `--ink-body`, the active one
 * filled `--selected` in ink. The option padding is the board's where the
 * control sits: `7px 12px` in a page header (7a), `8px 14px` in a 52px
 * toolbar (8a, 8b, 7b), `6px 12px` in the 44px Rig bar (9b, 6a, 3a). A
 * filter between a few views of the same thing — never a form field.
 */
export type SegmentedOption<T extends string> = { value: T; label: ReactNode };

type Props<T extends string> = {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  placement?: "page" | "toolbar" | "bar";
  className?: string;
};

const PAD = { page: "px-[12px] py-[7px]", toolbar: "px-[14px] py-[8px]", bar: "px-[12px] py-[6px]" } as const;

export default function Segmented<T extends string>({ value, options, onChange, label, placement = "page", className = "" }: Props<T>) {
  return (
    <div role="group" aria-label={label} className={`inline-flex gap-[2px] rounded-pill border border-border bg-card p-[2px] ${className}`}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} onClick={() => onChange(o.value)}
            className={`tap44 rounded-pill text-[13px] font-medium leading-none ${PAD[placement]} ${on ? "bg-selected text-ink" : "text-ink-body"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
