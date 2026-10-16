"use client";
import { useMemo } from "react";
import { reviewProjectTake } from "@/lib/workspace/library";
import { useJudge } from "@/components/graphite/board/cards/take/use-judge";
import { useTakeNotes } from "@/components/graphite/board/cards/take/use-take-notes";
import type { ShotTakes } from "@/components/graphite/board/cards/take/take-model";
import { useToast } from "../ui";
import { StepCard, type StepCardProps } from "./StepCard";
import { SHOT_REASONS, rejectedReason, shotCardPicture, shotCardState } from "./shot-card";

/**
 * A shot on the v25 board (PR 5): the card, fed by the shot's takes, with ✓ and ✕ doing what they have always done on a take, through the review trail
 * that exists today (components/graphite/board/cards/take/use-judge.ts): ✓ approves the shown version (one approved version a shot; an Undo is in the toast),
 * ✓ again takes it back to Ready, ✕ sends it back with a reason (the Shots chips, "Other", one line) recorded as a note on the take. Free, and only a person:
 * the routes refuse a token, an MCP caller and an agent identity (#723). Nothing is paid and nothing is erased.
 */
export function ShotStepCard({ row, scope, projectId, onOpen, onMenu, onSelect, ...rest }: {
  row: ShotTakes; scope: string; projectId: string;
} & Pick<StepCardProps, "onOpen" | "onMenu" | "onSelect" | "selected" | "dimmed" | "greyed" | "targeted" | "differs" | "chips" | "onChip" | "draggable" | "onDragStart" | "tile" | "poweredBy">) {
  const raise = useToast();
  const toast = useMemo(() => (text: string, undo?: { label: string; run: () => void }) => raise({ text, action: undo ? { label: "Undo", run: undo.run } : undefined }), [raise]);
  const judge = useJudge(scope, projectId, toast);
  const state = shotCardState(row);
  const rejectedGen = state.status === "rejected" && state.shown ? [state.shown.genId] : [];
  const notes = useTakeNotes(scope, rejectedGen);
  const reason = rejectedGen.length ? rejectedReason(notes.get(rejectedGen[0])) : undefined;
  const picture = shotCardPicture(row);
  const target = state.judge;

  const approve = () => {
    if (!target) return;
    if (state.status !== "approved") { void judge.approve(row, target); return; }
    /* ✓ on an approved card takes the approval back: the card is Ready again. */
    void reviewProjectTake(scope, projectId, target.genId, "").then(
      () => toast(`Shot ${row.index} ${target.label} is Ready again`),
      (error) => toast(error instanceof Error ? error.message : "The review was not saved."),
    );
  };
  return (
    <StepCard {...rest} id={row.nodeId} title={row.title} status={state.status} version={state.version} reason={reason} reasons={SHOT_REASONS}
      picture={picture} video={state.shown?.media === "video"} approvedBy={state.status === "approved" ? state.shown?.approvedBy ?? undefined : undefined}
      onSelect={onSelect} onOpen={onOpen} onMenu={onMenu}
      onApprove={target ? approve : undefined} onReject={target ? (why) => { void judge.reject(row, target, why); } : undefined} />
  );
}
