"use client";

/**
 * The switch (design/particl-v2/README.md §13; SOW surfaces board 12h):
 * 20 tall, radius 10, a 16px knob 2px in. On: the track in ink, the knob in
 * ground. Off: the track at .14 of ink, the knob in ink. No transition —
 * the knob is on one side or the other. A `switch` role with its checked
 * state and a label, and the 44pt band on a phone.
 *
 * Two widths, each a board's own number: 36 (board 12h, the platform
 * desk — the default) and 34 (board 4a, Settings › Engines & rates, where
 * it was lifted from). The knob's on-side offset follows the width: 18 at
 * 36, 16 at 34.
 */
export default function Switch({ on, onChange, label, disabled = false, className = "", width = 36 }: {
  on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; className?: string;
  /** 36 (board 12h, the default) or 34 (board 4a). */
  width?: 34 | 36;
}) {
  const track = width === 34 ? "w-[34px]" : "w-[36px]";
  const knobOn = width === 34 ? "left-[16px]" : "left-[18px]";
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`tap44 relative inline-block h-[20px] ${track} flex-none rounded-tile disabled:opacity-40 ${on ? "bg-ink" : "bg-[rgba(245,246,248,.14)]"} ${className}`}>
      <span className={`absolute top-[2px] h-[16px] w-[16px] rounded-full ${on ? `${knobOn} bg-ground` : "left-[2px] bg-ink"}`} />
    </button>
  );
}
