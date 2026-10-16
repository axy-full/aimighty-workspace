"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tooltip } from "../ui";
import { ENHANCE_LABEL, ENHANCE_TIP_LINE, ENHANCE_TIP_NAME } from "@/lib/v12/enhance";

/**
 * The Enhance button (prototype v14), with a separate ⓘ whose tooltip opens on hover, on keyboard focus, and on a tap or click, which pins
 * it open until a click elsewhere or Esc. The button wears its price ("Enhance · 1 cr") before it is pressed and says "Enhancing…" while the
 * enhancer works. It does one thing: the enhanced words land in the prompt box, and nothing is generated (components/graphite/make/use-make.ts
 * › pressEnhance). It is `aria-disabled`, not disabled, so its hover (the price's reason) still opens.
 */
export function EnhanceButton({ price, attrs, busy, disabled, why, onPress, testId = "v12-make-enhance", side = "top" }: {
  /** The quoted price, drawn by the caller (a Price), or nothing while there are no words. */
  price: ReactNode;
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
        {busy ? <span>Enhancing…</span> : <span>{ENHANCE_LABEL}{price ? <> · {price}</> : null}</span>}
      </button>
      <Tooltip name={ENHANCE_TIP_NAME} line={ENHANCE_TIP_LINE} side={side} pinned={pinned}>
        <button ref={info} type="button" className="v12-mk-enhance-info" aria-label="About Enhance" aria-expanded={pinned} onClick={() => setPinned((v) => !v)} data-testid={`${testId}-info`}>ⓘ</button>
      </Tooltip>
    </span>
  );
}
