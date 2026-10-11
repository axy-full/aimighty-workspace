"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A pill (docs/redesign/inventory.md § 3, § 5.1): 32 px (header pills) or 26 px (filter chips), radius 999, a control
 * border, an optional 7 px status dot. A pill with `onClick` is a button; `selected` gives it the accent tint.
 */
export type PillTone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Pill({ children, tone = "neutral", dot, pulse, size = "md", selected, onClick, className, ...rest }: {
  children: ReactNode;
  tone?: PillTone;
  /** A status dot in the tone's colour. */
  dot?: boolean;
  /** The dot pulses (a live job). Still under reduced motion. */
  pulse?: boolean;
  size?: "sm" | "md";
  selected?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const inner = <>{dot ? <span className="v12-pill-dot" data-pulse={pulse ? "" : undefined} aria-hidden /> : null}<span className="v12-pill-text">{children}</span></>;
  const common = { className: ["v12-pill", className].filter(Boolean).join(" "), "data-tone": tone, "data-size": size, "data-selected": selected ? "" : undefined };
  if (!onClick) return <span {...common}>{inner}</span>;
  return <button type="button" {...rest} {...common} aria-pressed={selected} onClick={onClick}>{inner}</button>;
}
