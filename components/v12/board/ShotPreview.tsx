"use client";
import { useMemo } from "react";
import { reviewProjectTake } from "@/lib/workspace/library";
import { useJudge } from "@/components/graphite/board/cards/take/use-judge";
import type { ShotTakes } from "@/components/graphite/board/cards/take/take-model";
import { useToast } from "../ui";
import { CardPreview, type CardPreviewProps } from "./CardPreview";
import { previewItemOfShot } from "./preview-model";

/**
 * The preview over the Shots step (PR 6): the shots' takes as preview items, ✓ and ✕ for the version on screen going through the same review trail as the
 * card's (use-judge.ts: ✓ approves that version and clears any other approved one of the shot, with an Undo; ✓ again takes it back; ✕ sends it back with
 * its reason as a note). Free, and only a person: the routes refuse anything else. Nothing is paid and nothing is erased.
 */
export function ShotPreview({ rows, scope, projectId, ...rest }: { rows: readonly ShotTakes[]; scope: string; projectId: string } & Pick<CardPreviewProps, "openId" | "onStep" | "onClose" | "inset" | "note" | "placement" | "onVersion">) {
  const raise = useToast();
  const toast = useMemo(() => (text: string, undo?: { label: string; run: () => void }) => raise({ text, action: undo ? { label: "Undo", run: undo.run } : undefined }), [raise]);
  const judge = useJudge(scope, projectId, toast);
  const items = useMemo(() => new Map(rows.map((row) => [row.nodeId, previewItemOfShot(row)] as const)), [rows]);
  const ids = useMemo(() => rows.map((row) => row.nodeId), [rows]);
  const target = (itemId: string, versionIndex: number) => {
    const row = rows.find((r) => r.nodeId === itemId);
    const genId = items.get(itemId)?.versions[versionIndex]?.genId;
    const version = row?.versions.find((v) => v.genId === genId);
    return row && version ? { row, version } : null;
  };
  return (
    <CardPreview {...rest} items={items} ids={ids}
      onApprove={(item, at) => {
        const t = target(item.id, at);
        if (!t) return;
        if (item.versions[at].status !== "approved") { void judge.approve(t.row, t.version); return; }
        void reviewProjectTake(scope, projectId, t.version.genId, "").then(
          () => toast(`Shot ${t.row.index} ${t.version.label} is Ready again`),
          (error) => toast(error instanceof Error ? error.message : "The review was not saved."),
        );
      }}
      onReject={(item, at, reason) => { const t = target(item.id, at); if (t) void judge.reject(t.row, t.version, reason); }} />
  );
}
