import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "control" | "amber" | "dashed";

type Common = { variant?: ButtonVariant; keyHint?: string | null; children: ReactNode; className?: string };

const classes = (variant: ButtonVariant, className = "") => `pxw-btn pxw-btn--${variant} ${className}`.trim();

/** Primary blue, control, amber approve and dashed add — one shape. */
export function Button({ variant = "control", keyHint, children, className, type = "button", ...rest }: Common & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={classes(variant, className)} {...rest}>
      {children}
      {keyHint ? <span className="pxw-btn-key" aria-hidden="true">{keyHint}</span> : null}
    </button>
  );
}

/** The same button as a link to an existing route. */
export function ButtonLink({ variant = "control", keyHint, children, className, ...rest }: Common & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={classes(variant, className)} {...rest}>
      {children}
      {keyHint ? <span className="pxw-btn-key" aria-hidden="true">{keyHint}</span> : null}
    </a>
  );
}
