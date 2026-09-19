import type { HTMLAttributes } from "react";

/**
 * Mono uppercase kicker. A functional label (section kicker, column header,
 * count) never renders dimmer than #7C7C84; it carries
 * `data-functional-label` so the contrast check can find it.
 */
export function Kicker({
  functional = true,
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { functional?: boolean }) {
  return (
    <span
      className={`pxw-kicker ${className}`.trim()}
      {...(functional ? { "data-functional-label": "" } : {})}
      {...rest}
    >
      {children}
    </span>
  );
}
