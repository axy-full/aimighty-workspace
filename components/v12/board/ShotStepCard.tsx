"use client";
import { useMemo } from "react";
import { useJudge } from "@/components/graphite/board/cards/take/use-judge";
import { useTakeNotes } from "@/components/graphite/board/cards/take/use-take-notes";
import type { ShotTakes } from "@/components/graphite/board/cards/take/take-model";
import { useToast } from "../ui";
import { StepCard, type StepCardProps } from "./StepCard";
import { SHOT_REASONS, rejectedReason, shotCardPicture, shotCardState } from "./shot-card";
import { V25_JUDGE } from "./card-model";

/**
 * A shot on the v25 board (PR 5): the card, fed by the shot's takes, with ✓ and ✕ doing what they have always done on a take, through the review trail
 * that exists today (components/graphite/board/cards/take/use-judge.ts): ✓ sends the shown version (the trail's "approved" mark, which the card calls Sent:
 * one a shot; an Undo is in the toast), ✓ again takes it back to Ready (as it was before, when known; an Undo sends it again), ✕ sends it back with a reason
 * (the Shots chips, or "Other" with a line of at least one word) recorded as a note on the take. ✓ and ✕ are drawn only when the shown version can be judged (finished, its picture here). Free, and only a person:
 * the routes refuse a token, an MCP caller and an agent identity (#723). Nothing is paid and nothing is erased.
 */
export function ShotStepCard({ row, scope, projectId, onOpen, onMenu, onSelect, ...rest }: {
  row: ShotTakes; scope: string; projectId: string;
} & Pick<StepCardProps, "onOpen" | "onMenu" | "onSelect" | "selected" | "dimmed" | "greyed" | "targeted" | "differs" | "chips" | "onChip" | "draggable" | "onDragStart" | "tile" | "poweredBy">) {
  const raise = useToast();
  const toast = useMemo(() => (text: string, undo?: { label: string; run: () => void }) => raise({ text, action: undo ? { label: "Undo", run: undo.run } : undefined }), [raise]);
  const judge = useJudge(scope, projectId, toast, V25_JUDGE);
  const state = shotCardState(row);
  const rejectedGen = state.status === "rejected" && state.shown ? [state.shown.genId] : [];
  const notes = useTakeNotes(scope, rejectedGen);
  const reason = rejectedGen.length && state.shown ? rejectedReason(notes.get(rejectedGen[0]), state.shown.updatedAt) : undefined;
  const picture = shotCardPicture(row);
  const target = state.judge;

  /* ✓ on a sent card takes it back: the card is Ready again (through the judge, so a second press while one is saving does nothing). */
  const approve = () => {
    if (!target) return;
    void (target.status === "approved" ? judge.unapprove(row, target) : judge.approve(row, target));
  };
  return (
    <StepCard {...rest} id={row.nodeId} title={row.title} status={state.status} version={state.version} reason={reason} reasons={SHOT_REASONS}
      picture={picture} video={state.shown?.media === "video"} approvedBy={state.status === "approved" ? state.shown?.approvedBy ?? undefined : undefined}
      onSelect={onSelect} onOpen={onOpen} onMenu={onMenu}
      onApprove={target ? approve : undefined} onReject={target ? (why) => { void judge.reject(row, target, why); } : undefined} />
  );
}
