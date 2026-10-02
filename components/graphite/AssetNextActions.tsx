"use client";
import { useId, useState } from "react";
import { nextActions, notOfferedLine, pricedActions, NEXT_SECTION, type NextActionId, type PricedActionId } from "@/lib/shell/next-actions";
import type { LibraryEntry } from "@/lib/workspace/library";
import { NextActionPanel } from "./NextActionPanel";

/**
 * The Next row (idea 12). First, the way into the existing tool each take goes
 * on to — for a still, Re-edit; for a clip, Edit; for a sound, Edit & Sound —
 * navigation only, the tool's own priced button being its paid control. Then
 * the priced actions that make a new take from this one (a still: Upscale,
 * Outpaint, Animate; a clip: Upscale, Reframe, Extend), each opening its own
 * settings, estimate and button here (NextActionPanel); and, for a sound, the
 * ones no engine here does, said as not offered. The Inspector and the Takes
 * desk's selected take both show it (lib/shell/next-actions.ts says which
 * apply, and why one cannot yet).
 */
export function AssetNextActions({ entry, saved, onAction, scope, project, onOpenTake }: {
  entry: LibraryEntry;
  saved: boolean;
  onAction: (id: NextActionId) => void;
  /** Where the priced actions run: the workspace's scope and the project (its production once saved). Without them the row only navigates. */
  scope?: string;
  project?: { id: string; productionProjectId?: string } | null;
  /** Open a take by its library id: the new take an action made. */
  onOpenTake?: (id: string) => void;
}) {
  const [open, setOpen] = useState<{ take: string; id: PricedActionId } | null>(null);
  const panelId = useId();
  const actions = nextActions(entry, { saved });
  const priced = scope && project ? pricedActions(entry, { saved }) : [];
  if (!actions.length && !priced.length) return null;
  const openId = open?.take === entry.take.id ? open.id : null;
  const current = openId ? priced.find((a) => a.id === openId && a.enabled) ?? null : null;
  /* Why what cannot go yet cannot, once each (a take still rendering blocks them all for one reason); what no engine here does, on its own line. */
  const whys = [...new Set([...actions, ...priced.filter((a) => a.offered)].filter((a) => !a.enabled && a.why).map((a) => a.why as string))];
  const none = notOfferedLine(priced);
  return (
    <div className="gx-next" role="group" aria-label={`Next for ${entry.take.name}`} data-testid="next-actions">
      <span className="gx-eyebrow" data-functional-label="">Next</span>
      <div className="gx-next-row">
        {actions.map((a) => (
          <button key={a.id} type="button" className="gx-hbtn" disabled={!a.enabled} title={a.enabled ? `Opens ${a.opens}` : a.why ?? undefined}
            onClick={() => onAction(a.id)} data-testid={`next-${a.id}`}>{a.label} ›</button>
        ))}
        {priced.map((a) => (
          <button key={a.id} type="button" className="gx-hbtn gx-next-priced" disabled={!a.enabled}
            aria-expanded={a.enabled ? openId === a.id : undefined} aria-controls={openId === a.id ? panelId : undefined}
            title={a.enabled ? `${a.label} on ${a.engine}: a new take, priced before it runs` : a.offered ? a.why ?? undefined : `Not offered: ${a.why ?? ""}`}
            data-offered={a.offered ? undefined : "false"}
            onClick={() => setOpen(openId === a.id ? null : { take: entry.take.id, id: a.id })} data-testid={`next-${a.id}`}>{a.label}</button>
        ))}
      </div>
      {whys.length ? <p className="gx-reason" data-testid="next-why">{whys.join(" ")}</p> : null}
      {none ? <p className="gx-reason" data-testid="next-not-offered">{none}</p> : null}
      {current && scope && project?.productionProjectId ? (
        <NextActionPanel key={`${entry.take.id}:${current.id}`} id={panelId} scope={scope} entry={entry} action={current}
          project={{ id: project.id, productionProjectId: project.productionProjectId }} onClose={() => setOpen(null)} onOpenTake={onOpenTake} />
      ) : null}
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
