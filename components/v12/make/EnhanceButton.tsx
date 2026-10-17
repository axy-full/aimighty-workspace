"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "../ui";
import { ENHANCE_LABEL, ENHANCE_TIP_NAME, ENHANCE_WORKING } from "@/lib/v12/enhance";

/**
 * The dot-arc loader: eight dots on three quarters of a circle, each fading in turn. Only shapes and `currentColor`: a new look changes the paint (and the
 * `v12-arc` keyframes in make.css), not this drawing. Reduced motion holds it still, the dots at their steps of brightness.
 */
export function DotArc({ size = 16 }: { size?: number }) {
  const dots = Array.from({ length: 8 }, (_, i) => {
    const angle = (-90 + i * (270 / 7)) * (Math.PI / 180);
    return { x: 8 + 5.6 * Math.cos(angle), y: 8 + 5.6 * Math.sin(angle), i };
  });
  return (
    <svg className="v12-arc" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-testid="v12-arc">
      {dots.map((d) => <circle key={d.i} className="v12-arc-dot" cx={d.x} cy={d.y} r="1.35" style={{ animationDelay: `${d.i * 0.11}s`, opacity: 0.25 + d.i * 0.1 }} fill="currentColor" />)}
    </svg>
  );
}

/**
 * The Enhance button (prototype v14), with a separate ⓘ whose tooltip opens on hover, on keyboard focus, and on a tap or click, which pins
 * it open until a click elsewhere or Esc. The button wears its price ("Enhance · 1 cr") before it is pressed and says "Enhancing…" while the
 * enhancer works. It does one thing: the enhanced words land in the prompt box, and nothing is generated (components/graphite/make/use-make.ts
 * › pressEnhance). It is `aria-disabled`, not disabled, so its hover (the price's reason) still opens.
 */
export function EnhanceButton({ price, tip, attrs, busy, disabled, why, onPress, testId = "v12-make-enhance", side = "top" }: {
  /** The quoted price, drawn by the caller (a Price), or nothing while there are no words. */
  price: ReactNode;
  /** The hover label's second line, with the server's price for this press (lib/v12/enhance.ts enhanceTipLine). */
  tip: string;
  /** The spend marks of the figure on the button (lib/spend.ts). */
  attrs?: object;
  busy: boolean;
  disabled: boolean;
  /** Why it cannot be pressed right now. */
  why?: string | null;
  onPress: () => void;
  testId?: string;
  side?: "top" | "bottom";
}) {
  const [pinned, setPinned] = useState(false);
  const info = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const away = (event: PointerEvent) => { if (!info.current?.contains(event.target as Node)) setPinned(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setPinned(false); };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", esc, true); };
  }, [pinned]);
  const off = disabled || busy;
  return (
    <span className="v12-mk-enhance-group" data-testid={`${testId}-group`}>
      <button type="button" className="v12-mk-enhance" aria-disabled={off || undefined} aria-busy={busy || undefined} title={!busy && disabled ? why ?? undefined : undefined}
        onClick={() => { if (!off) onPress(); }} data-testid={testId} {...attrs}>
        {busy ? <span className="v12-mk-enhance-working"><DotArc />{ENHANCE_WORKING}</span> : <span>{ENHANCE_LABEL}{price ? <> · {price}</> : null}</span>}
      </button>
      <Tooltip name={ENHANCE_TIP_NAME} line={tip} side={side} pinned={pinned}>
        <button ref={info} type="button" className="v12-mk-enhance-info" aria-label="About Enhance" aria-expanded={pinned} onClick={() => setPinned((v) => !v)} data-testid={`${testId}-info`}>ⓘ</button>
      </Tooltip>
    </span>
  );
}
