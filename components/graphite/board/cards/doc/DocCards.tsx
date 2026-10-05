"use client";
import { useEffect, useMemo, useState } from "react";
import { sha256Hex } from "@/lib/production/hash";
import type { BoardCard } from "@/lib/board/types";
import type { BeatRemoval } from "@/lib/production/beats";
import type { BoardCtx, CardProps } from "../types";
import type { DocData } from "../plan/derive";
import { frameState } from "../storyboard/model";
import { BriefDocCard, NodeDocCard } from "./BriefDocCard";
import { shotRows, withBriefField, withNewShot, withNodeText, withShotBack, withShotDuration, withShotField, withoutShot } from "./model";
import { ShotListDoc, type ShotState } from "./ShotListDoc";
import { shotListState, type ShotListState, type ShotTakes } from "../take/take-model";

/** Why the board can't be edited now, or null (offline: the board is read-only, README § 3.1). */
export function readOnlyOf(ctx: Pick<BoardCtx, "offline">): string | null {
  return ctx.offline ? "Needs a connection" : null;
}

/** The `doc` card: the project's brief, or a brief placed on the canvas, edited in place through the Rig seam. */
export function DocCard({ data, ctx }: CardProps<DocData>) {
  const readOnly = readOnlyOf(ctx);
  if (data.variant === "brief")
    return <BriefDocCard doc={data.doc} readOnly={readOnly} onEdit={(field, value) => { ctx.rig.apply((p) => withBriefField(p, field, value)); }} />;
  return <NodeDocCard title={data.title} text={data.text} readOnly={readOnly} onEdit={(value) => { ctx.rig.apply((p) => withNodeText(p, data.nodeId, value)); }} />;
}

/**
 * The board's List view (README § 1.2): the shot list, edited in place. Rows are the beat sheet's shots; their
 * state is the storyboard's (Planned, Drawing, Storyboarded) until the Shots cards give theirs. A row's number
 * selects its frame on the board.
 */
export function ShotList({ ctx, cards, stateOf }: { ctx: BoardCtx; cards: readonly BoardCard[]; stateOf?: (shotId: string) => ShotState | null }) {
  const project = ctx.project;
  const rows = useMemo(() => shotRows(project.production?.beats), [project.production?.beats]);
  const script = project.script ?? "";
  const [sha, setSha] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void sha256Hex(script).then((h) => { if (alive) setSha(h); });
    return () => { alive = false; };
  }, [script]);
  const readOnly = readOnlyOf(ctx);
  const now = () => new Date().toISOString();
  /* The Shots cards' state for a shot, by its beat-sheet id (their take cards carry their row); else the storyboard's. */
  const fromShots = useMemo(() => {
    const out = new Map<string, ShotState>();
    for (const card of cards) {
      if (card.kind !== "take" || !card.nodeId) continue;
      const row = (card.data as { row?: ShotTakes }).row;
      const state = row ? shotListState(row) : null;
      const beat = project.nodes.find((n) => n.id === card.nodeId)?.boardShotId;
      if (state && beat) out.set(beat, shotState(state));
    }
    return out;
  }, [cards, project.nodes]);
  const onCard = (shotId: string) => cards.some((c) => c.id === `frame:${shotId}`);
  return (
    <ShotListDoc
      rows={rows}
      stateOf={stateOf ?? ((shotId) => fromShots.get(shotId) ?? frameState(project, shotId))}
      readOnly={readOnly}
      onField={(shotId, field, value) => { ctx.rig.apply((p) => withShotField(p, shotId, field, value, now())); }}
      onDuration={(shotId, seconds) => { ctx.rig.apply((p) => withShotDuration(p, shotId, seconds, now())); }}
      onAdd={sha ? () => { ctx.rig.apply((p) => withNewShot(p, sha, now())?.project ?? p); } : null}
      onRemove={(shotId) => {
        const index = rows.find((r) => r.id === shotId)?.index;
        const taken: { removal: BeatRemoval | null } = { removal: null };
        ctx.rig.apply((p) => {
          const out = withoutShot(p, shotId, now());
          if (!out) return p;
          taken.removal = out.removal;
          return out.project;
        });
        const removal = taken.removal;
        if (!removal) return;
        ctx.toast(index ? `Shot ${index} taken out` : "Shot taken out", {
          label: "Undo",
          run: () => { ctx.rig.apply((p) => withShotBack(p, removal, now()) ?? p); },
        });
      }}
      onSelect={(shotId) => { if (onCard(shotId)) { ctx.select(`frame:${shotId}`); ctx.glide({ card: `frame:${shotId}` }); } }}
    />
  );
}

/** Stream 5's list state in the table's words and tones. */
function shotState(state: ShotListState): ShotState {
  const tone = state.tone === "done" ? "done" : state.tone === "waiting" ? "waiting" : state.tone === "live" ? "accent" : state.tone === "failed" ? "failed" : "quiet";
  return { label: state.word, tone };
}
