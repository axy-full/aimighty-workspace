"use client";
import { useEffect } from "react";
import LazyMedia from "@/components/LazyMedia";
import { usePriceTitle } from "@/components/graphite/Price";
import { exact, priceWords } from "@/lib/shell/price-words";
import { spendAttrsOf } from "@/lib/spend";
import { hasStaleBlockingInputs, tidyBlockingInputs } from "@/lib/production/blocking";
import { useShell } from "@/lib/shell/state";
import { useShotEstimate } from "@/lib/workspace/use-shot-estimate";
import type { BoardCtx } from "../cards/types";
import { openBlocking } from "./blocking-store";
import { savedTime, type ShotBlockingView } from "./shot-blocking";
import "./blocking.css";

/**
 * The saved 3D blocking on a shot's own card (gap screens): the frame, "3D blocking · 85mm", "Reference · saved 10:20 · free",
 * Remake Shot N with its price from the server's own estimate for the shot's engine and length, and a way back into the overlay.
 * Remake hands the shot and its blocking frame to Make, which prices the exact request again before anything is sent: pressing it
 * here spends nothing. Opening and saving the blocking are free.
 */
export function ShotBlockingStrip({ ctx, nodeId, index, view }: { ctx: BoardCtx; nodeId: string; index: number; view: ShotBlockingView }) {
  const shell = useShell();
  const shot = ctx.rig.shots.find((s) => s.id === nodeId) ?? null;
  const estimate = useShotEstimate({ engine: shot?.engine, durationS: shot?.durationS, ratio: shot?.ratio, resolution: shot?.resolution });
  const price = estimate.credits != null && shot ? exact(estimate.credits) : null;
  const title = usePriceTitle(price);
  const words = priceWords(price);
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  const node = ctx.project.nodes.find((n) => n.id === nodeId);
  /* Two windows saving a frame to this shot at once leave two blocking inputs after the merge: the older one is taken off (the Library file stays). */
  const stale = hasStaleBlockingInputs(ctx.project, nodeId);
  const apply = ctx.rig.apply, save = ctx.rig.save;
  useEffect(() => {
    if (!stale || ctx.offline || ctx.readOnly || ctx.exploreOnly) return;
    if (!apply((p) => tidyBlockingInputs(p, nodeId))) void save();
    // The extra inputs are what the check reads; this runs once per time they appear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, nodeId]);
  const remake = () => {
    if (!shot || !node) return;
    const asset = ctx.project.production?.blocking?.[nodeId]?.frameAssetId;
    const frame = asset ? [...ctx.project.assets, ...(ctx.project.sharedAssets ?? [])].find((a) => a.id === asset) : undefined;
    shell.openMake({
      prompt: (node.text ?? "").trim(), model: shot.engine, type: "video",
      picks: { ratio: shot.ratio, resolution: shot.resolution, ...(shot.durationS ? { duration: shot.durationS } : {}) },
      note: `Remake · Shot ${index} · 3D blocking`,
      ...(frame?.uploadId ? { references: [{ origin: "upload" as const, id: frame.uploadId, kind: "image" as const }] } : {}),
    });
  };
  return (
    <div className="gx-bk-strip nodrag nopan" data-testid="shot-blocking" onDoubleClick={(e) => e.stopPropagation()}>
      <span className="gx-bk-thumb">
        {view.frameUploadId ? <LazyMedia url={`/api/workbench/preview/upload/${encodeURIComponent(view.frameUploadId)}`} kind="image" alt="" preview={false} /> : null}
      </span>
      <span>
        <span className="gx-bk-strip-name" style={{ display: "block" }}>3D blocking · {view.lens}mm</span>
        <span className="gx-bk-strip-meta" style={{ display: "block" }}>Reference{view.savedAt ? ` · saved ${savedTime(view.savedAt)}` : ""} · free</span>
      </span>
      <span className="gx-bk-strip-acts">
        <button type="button" className="gx-bk-btn" title={title ?? blocked ?? undefined} {...spendAttrsOf(price)} disabled={Boolean(blocked) || !price}
          onClick={(e) => { e.stopPropagation(); remake(); }} data-testid="blocking-remake">{words ? `Remake Shot ${index} · ${words}` : `Remake Shot ${index}`}</button>
        <button type="button" className="gx-bk-btn" onClick={(e) => { e.stopPropagation(); openBlocking(nodeId); }} data-testid="blocking-reopen">Open 3D blocking</button>
      </span>
    </div>
  );
}
