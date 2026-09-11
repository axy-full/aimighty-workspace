"use client";

import { useDnd } from "@/lib/useDnd";
import Mono from "./Mono";

/** The card that follows the pointer while a drag is on (CR1 §11): a small pill with the thing's name, never in the way of the drop. */
export default function DragGhost() {
  const { drag, x, y } = useDnd();
  if (!drag) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed z-[70] flex items-center gap-[6px] rounded-pill border border-border-mid bg-card px-[10px] py-[6px] text-[12.5px] font-medium leading-none text-ink"
      style={{ left: x + 12, top: y + 12 }}>
      <Mono>{drag.kind}</Mono><span className="max-w-[220px] truncate">{drag.label}</span>
    </div>
  );
}
