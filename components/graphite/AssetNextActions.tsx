"use client";
import { nextActions, NEXT_SECTION, type NextActionId } from "@/lib/shell/next-actions";
import type { LibraryEntry } from "@/lib/workspace/library";

/**
 * The Next row (idea 12, first slice): for a still, Re-edit; for a clip,
 * Edit; for a sound, Edit & Sound — each opens the existing tool that does it,
 * on this take. Navigation only: no quote, no price and no request here; the
 * tool's own priced button, after its own quote, is the only paid control.
 * The Inspector and the Takes desk's selected take both show it
 * (lib/shell/next-actions.ts says which apply, and why one cannot yet).
 */
export function AssetNextActions({ entry, saved, onAction }: { entry: LibraryEntry; saved: boolean; onAction: (id: NextActionId) => void }) {
  const actions = nextActions(entry, { saved });
  if (!actions.length) return null;
  const blocked = actions.find((a) => !a.enabled && a.why);
  return (
    <div className="gx-next" role="group" aria-label={`Next for ${entry.take.name}`} data-testid="next-actions">
      <span className="gx-eyebrow" data-functional-label="">Next</span>
      <div className="gx-next-row">
        {actions.map((a) => (
          <button key={a.id} type="button" className="gx-hbtn" disabled={!a.enabled} title={a.enabled ? `Opens ${a.opens}` : a.why ?? undefined}
            onClick={() => onAction(a.id)} data-testid={`next-${a.id}`}>{a.label} ›</button>
        ))}
      </div>
      {blocked ? <p className="gx-reason" data-testid="next-why">{blocked.why}</p> : null}
    </div>
  );
}

/**
 * Bring a tool's section of the Takes desk into view once it is on the page
 * (after a page change it mounts when the project's library has the take);
 * `focus` puts the cursor in its first field. The desk brings a newly opened
 * take's panel into view on its own, a frame or two later: for a moment after
 * landing, the section is put back at the top if that moved it. Gives up
 * quietly after a few seconds.
 */
export function revealNext(id: NextActionId, focus = id === "re-edit", within = 4000, hold = 800) {
  const section = NEXT_SECTION[id];
  if (!section || typeof window === "undefined") return;
  const until = performance.now() + within;
  const look = () => {
    const found = document.querySelector<HTMLElement>(`[data-section="${section}"]`);
    if (!found) { if (performance.now() < until) requestAnimationFrame(look); return; }
    found.scrollIntoView({ block: "start" });
    if (focus) found.querySelector<HTMLElement>("textarea")?.focus({ preventScroll: true });
    const settled = performance.now() + hold;
    const keep = () => {
      if (!found.isConnected) return;
      const top = found.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight / 2) found.scrollIntoView({ block: "start" });
      if (performance.now() < settled) requestAnimationFrame(keep);
    };
    requestAnimationFrame(keep);
  };
  requestAnimationFrame(look);
}
