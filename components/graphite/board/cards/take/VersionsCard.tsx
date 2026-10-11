"use client";
import { useMemo } from "react";
import { useVerifications } from "@/components/workspace/rig/use-verifications";
import { isVerifyCard } from "@/lib/workbench/verify";
import { defineCard, type CardProps } from "../types";
import type { TakeCardData } from "./shots-derive";
import { hhmm, shotHistory } from "./take-model";
import { useTakeNotes } from "./use-take-notes";

/*
 * Frame g's Versions card: the shot's history, newest first — each version as it was made (a change with its
 * words), Atomik's check of it, the team's notes (a reject's reason is one) and its sign-offs, each with its
 * time. Every row is recorded data; nothing here is paid.
 */

export function VersionsCard({ data, ctx }: CardProps<TakeCardData>) {
  const { row } = data;
  const checked = ctx.project.nodes.some(isVerifyCard);
  const { list } = useVerifications(ctx.scope, checked ? ctx.project.id : null);
  const notes = useTakeNotes(ctx.scope, row.versions.map((v) => v.genId));
  const rows = useMemo(() => shotHistory(row.versions, { verifications: list, notes }), [row.versions, list, notes]);
  return (
    <article className="gx-take-versions" aria-label={`Versions of shot ${row.index}`} data-testid="take-versions">
      <div className="gx-take-versions-title">Versions</div>
      <ol className="gx-take-versions-list nowheel">
        {rows.map((r) => (
          <li key={r.key} className="gx-take-versions-row">
            <span className="gx-take-versions-text">{r.text}</span>
            <time className="gx-take-versions-time" dateTime={new Date(r.at).toISOString()}>{hhmm(r.at)}</time>
          </li>
        ))}
      </ol>
    </article>
  );
}

/** 364 wide, as drawn; five rows show, more scroll inside the card (16 + 30 + 5 × 45 + 16). */
export const versionsDef = defineCard<TakeCardData>({
  kind: "versions",
  size: () => ({ w: 364, h: 287 }),
  Card: VersionsCard,
});
