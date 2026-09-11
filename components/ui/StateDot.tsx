/**
 * State dot (design/particl-v2/README.md §3), exactly as the boards draw it
 * (the reference's `dot()`):
 *
 *   approved · done   accent fill            — the only accent on the page
 *   picked            ink fill
 *   running           2px solid accent
 *   draft             1.5px solid --ink-muted
 *   queued · none     1.5px dashed --ink-muted — no take yet
 *   type              the same dashed dot: a shot that is type only and never renders (10a)
 *   needsYou          ink fill with a ground stroke, so it swells off the card (§3; no board
 *                     draws one, so the 3px is the ring's)
 *
 * 6px in a chip over a well, 7px in a state chip, 8px on a project tile,
 * 9px in the stepper.
 */
export type DotState = "approved" | "done" | "picked" | "running" | "draft" | "queued" | "none" | "type" | "needsYou";

const LOOK: Record<DotState, string> = {
  approved: "bg-accent",
  done: "bg-accent",
  picked: "bg-ink",
  running: "border-2 border-accent",
  draft: "border-[1.5px] border-ink-muted",
  queued: "border-[1.5px] border-dashed border-ink-muted",
  none: "border-[1.5px] border-dashed border-ink-muted",
  type: "border-[1.5px] border-dashed border-ink-muted",
  needsYou: "bg-ink outline outline-[3px] outline-ground",   // a stroke, not a shadow: §2 allows one ring in the product, and it is not this
};

/** The colour the state's word takes beside the dot (board 10a `stateColor`). */
export const STATE_TONE: Record<DotState, string> = {
  approved: "text-accent", done: "text-accent", picked: "text-ink", running: "text-ink",
  draft: "text-ink-muted", queued: "text-ink-muted", none: "text-ink-muted", type: "text-ink-muted", needsYou: "text-ink",
};

export default function StateDot({ state, size = 8, className = "" }: { state: DotState; size?: 6 | 7 | 8 | 9; className?: string }) {
  return (
    <span aria-hidden="true" className={`inline-block flex-none rounded-full ${LOOK[state]} ${className}`}
      style={{ width: size, height: size }} />
  );
}
