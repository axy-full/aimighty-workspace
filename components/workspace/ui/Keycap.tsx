import type { HTMLAttributes } from "react";

/** A keyboard hint: mono, 1px #26262A border, radius 5, padding 1px 5px. */
export function Keycap({ className = "", children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <kbd className={`pxw-keycap ${className}`.trim()} {...rest}>
      {children}
    </kbd>
  );
}
