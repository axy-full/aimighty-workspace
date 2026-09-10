"use client";

import Ring from "@/components/atomik/Ring";
import { useAtomikRail } from "@/lib/atomikRail";

/**
 * The Atomik header button (design/particl-v2/README.md §4; boards 4a, 10a):
 * a 36px pill, `0 12px`, Outfit 500 13px, the ring at 14 in its live state,
 * the label, and a mono suffix — `⌘J` on its own with no run (4a, where the
 * label reads `Ask Atomik`), or the run's state before it (`CHECKPOINT ·
 * ⌘J`, `RUNNING · ⌘J`, at .08em) with the label `Atomik` (10a). Border .14
 * when the rail is closed; .35 and `--selected` fill while it is open.
 *
 * The live state comes from the current run once runs exist (§9, step 6);
 * until then the ring is idle and the suffix is the shortcut alone.
 */
export default function AtomikButton() {
  const { open, toggle } = useAtomikRail();
  const runState: string | null = null;
  return (
    <button type="button" onClick={toggle} aria-pressed={open} aria-keyshortcuts="Meta+J"
      className={`flex h-[36px] items-center gap-[8px] rounded-pill border px-[12px] text-[13px] font-medium leading-none text-ink ${
        open ? "border-[rgba(245,246,248,.35)] bg-selected" : "border-border-mid"}`}>
      <Ring mode="idle" size={14} />
      {runState ? "Atomik" : "Ask Atomik"}
      <span className={`ui-mono text-ink-muted ${runState ? "ui-mono-cost" : "tracking-normal"}`}>
        {runState ? `${runState} · ⌘J` : "⌘J"}
      </span>
    </button>
  );
}
