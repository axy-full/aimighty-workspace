"use client";
import { useEffect, useRef, useState } from "react";
import { Tooltip } from "../ui";
import { ENHANCE_LABEL, ENHANCE_TIP_LINE, ENHANCE_TIP_NAME } from "@/lib/v12/enhance";

/**
 * The Enhance switch (prototype v14): "Enhance" with its switch, and beside it a separate ⓘ whose tooltip opens on hover,
 * on keyboard focus, and on a tap or click, which pins it open until a click elsewhere or Esc. The words are the owner's, in
 * lib/v12/enhance.ts. Used wherever a press makes a take; the choice itself is kept by the caller (per person and workspace).
 */
export function EnhanceSwitch({ on, onChange, testId = "v12-make-enhance", side = "top" }: { on: boolean; onChange: (next: boolean) => void; testId?: string; side?: "top" | "bottom" }) {
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
  return (
    <span className="v12-mk-enhance-group" data-testid={`${testId}-group`}>
      <button type="button" role="switch" aria-checked={on} className="v12-mk-enhance" onClick={() => onChange(!on)} data-testid={testId}>
        <span>{ENHANCE_LABEL}</span>
        <span className="v12-mk-enhance-track" aria-hidden="true" data-on={on ? "" : undefined}><span className="v12-mk-enhance-knob" /></span>
      </button>
      <Tooltip name={ENHANCE_TIP_NAME} line={ENHANCE_TIP_LINE} side={side} pinned={pinned}>
        <button ref={info} type="button" className="v12-mk-enhance-info" aria-label="About Enhance" aria-expanded={pinned} onClick={() => setPinned((v) => !v)} data-testid={`${testId}-info`}>ⓘ</button>
      </Tooltip>
    </span>
  );
}
