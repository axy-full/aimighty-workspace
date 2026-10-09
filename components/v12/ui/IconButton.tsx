"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Tooltip, type TooltipContent } from "./Tooltip";
import type { Side } from "./place";

/**
 * A button that is only an icon. Its tooltip is required by the type (docs/redesign/inventory.md § 4.3: every icon has
 * one: name · one line · shortcut · price), and its accessible name is the tooltip's name unless `label` says more.
 */
export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> & {
  tooltip: TooltipContent;
  children: ReactNode;
  label?: string;
  size?: "sm" | "md";
  pressed?: boolean;
  side?: Side;
};

export function IconButton({ tooltip, children, label, size = "md", pressed, side, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <Tooltip {...tooltip} side={side}>
      <button {...rest} type={type} aria-label={label ?? tooltip.name} aria-pressed={pressed}
        className={["v12-iconbtn", className].filter(Boolean).join(" ")} data-size={size}>
        {children}
      </button>
    </Tooltip>
  );
}
