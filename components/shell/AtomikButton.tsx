"use client";

import Ring from "@/components/atomik/Ring";
import { useAtomik } from "@/components/atomik/AtomikProvider";
import { useAtomikRail } from "@/lib/atomikRail";

/**
 * The Atomik header button (design/particl-v2/README.md §4; boards 4a, 10a):
 * a 36px pill, `0 12px`, Outfit 500 13px, the ring at 14 in its live state,
 * the label, and a mono suffix — `⌘J` on its own with nothing under way
 * (4a, where the label reads `Ask Atomik`), or the state before it
 * (`CHECKPOINT · ⌘J`, `RUNNING · ⌘J`, at .08em) with the label `Atomik`
 * (10a). Border .14 when the rail is closed; .35 and `--selected` fill
 * while it is open.
 */
export default function AtomikButton() {
  const { open, toggle } = useAtomikRail();
  const { ring, word } = useAtomik();
  return (
    <button type="button" onClick={toggle} aria-pressed={open} aria-keyshortcuts="Meta+J"
      className={`flex h-[36px] items-center gap-[8px] rounded-pill border px-[12px] text-[13px] font-medium leading-none text-ink ${
        open ? "border-[rgba(245,246,248,.35)] bg-selected" : "border-border-mid"}`}>
      {"steps" in ring ? <Ring steps={ring.steps} size={14} /> : <Ring mode={ring.mode} size={14} />}
      {word ? "Atomik" : "Ask Atomik"}
      <span className={`ui-mono text-ink-muted ${word ? "ui-mono-cost" : "tracking-normal"}`}>
        {word ? `${word} · ⌘J` : "⌘J"}
      </span>
    </button>
  );
}
