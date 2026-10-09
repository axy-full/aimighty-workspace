"use client";
import { cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";
import { v12PortalRoot } from "./overlay";
import { place, type Side } from "./place";

/**
 * What a tooltip says (docs/redesign/inventory.md § 4.3): its name, one line on what it does, its shortcut, and its
 * price. The price is a slot: it takes the quote's own element (lib/price.ts, later <Price>), never a written number.
 * `shortcut` takes one key run ("⌘K") or several alternatives (["G H", "⌘1"]); keys in a run are split on spaces.
 */
export type TooltipContent = {
  name: string;
  line?: string;
  shortcut?: string | readonly string[];
  price?: ReactNode;
};

/** The hover delay. Moving from one tooltip to the next within WARM_MS shows the next at once. */
export const TIP_DELAY_MS = 450;
const WARM_MS = 400;
let lastHidden = 0;

export function TooltipBody({ name, line, shortcut, price }: TooltipContent) {
  const runs = shortcut === undefined ? [] : typeof shortcut === "string" ? [shortcut] : shortcut;
  return (
    <>
      <span className="v12-tip-head">
        <span className="v12-tip-name">{name}</span>
        {runs.length ? <span className="v12-tip-keys">{runs.map((run, i) => <Kbd key={i} keys={run.split(" ").filter(Boolean)} />)}</span> : null}
      </span>
      {line ? <span className="v12-tip-line">{line}</span> : null}
      {price ? <span className="v12-tip-price">{price}</span> : null}
    </>
  );
}

/**
 * A real tooltip, not `title=`: shown on hover and on keyboard focus after a short delay, hidden on leave, blur, Esc or
 * a press; drawn above the page and kept on screen (components/v12/ui/place.ts). The child must be one focusable
 * element; it gets aria-describedby pointing at the tooltip.
 */
export function Tooltip({ children, side = "bottom", delay = TIP_DELAY_MS, disabled = false, ...content }: TooltipContent & {
  children: ReactElement<{ "aria-describedby"?: string }>;
  side?: Side;
  delay?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number; side: Side } | null>(null);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const show = useCallback(() => {
    clear();
    if (disabled) return;
    const wait = Date.now() - lastHidden < WARM_MS ? 0 : delay;
    timer.current = setTimeout(() => setOpen(true), wait);
  }, [delay, disabled]);
  const hide = useCallback(() => {
    clear();
    setOpen((was) => { if (was) lastHidden = Date.now(); return false; });
    setAt(null);
  }, []);

  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", hide, true); };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !tip.current) return;
    const target = (anchor.current?.firstElementChild ?? anchor.current) as HTMLElement | null;
    if (!target) return;
    const a = target.getBoundingClientRect();
    /* offsetWidth, not the bounding box: the box is mid-animation (scale .97) when it is measured. */
    const b = { width: tip.current.offsetWidth, height: tip.current.offsetHeight };
    setAt(place({ left: a.left, top: a.top, width: a.width, height: a.height }, { width: b.width, height: b.height }, { width: window.innerWidth, height: window.innerHeight }, side));
  }, [open, side, content.name, content.line]);

  const child = isValidElement(children)
    ? cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], open ? id : null].filter(Boolean).join(" ") || undefined })
    : children;
  const root = open && !disabled ? v12PortalRoot() : null;

  return (
    <>
      <span ref={anchor} className="v12-tip-anchor"
        onPointerEnter={(e) => { if (e.pointerType === "mouse") show(); }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={(e) => { if ((e.target as Element).matches?.(":focus-visible")) show(); }}
        onBlur={hide}>
        {child}
      </span>
      {root ? createPortal(
        <div ref={tip} id={id} role="tooltip" className="v12-tip" data-side={at?.side ?? side} data-testid="v12-tooltip"
          style={at ? { left: at.left, top: at.top } : { left: 0, top: 0, visibility: "hidden" }}>
          <TooltipBody {...content} />
        </div>,
        root,
      ) : null}
    </>
  );
}
