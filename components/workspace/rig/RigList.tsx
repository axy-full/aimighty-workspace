"use client";
import { BuildFromBoards } from "@/components/graphite/production/RigExtras";
import { useState } from "react";
import type { Asset } from "@/lib/workbench/studio";
import { engineLabel } from "@/lib/workspace/engines";
import { mediaBands } from "@/lib/workspace/format";
import { shotPreviewAsset } from "@/lib/workspace/rig";
import type { RigShot, RigShotStatus } from "@/lib/workspace/shots";
import { StatusPill, type Status } from "../ui";
import { useRig } from "./RigProvider";
import { RIG_NO_PROJECT, rigLoadState } from "@/lib/workspace/rig-load-state";
import { useWorkspace } from "@/lib/workspace/state";
import { canDropOnShot, dropOnShot } from "@/lib/shell/drop-targets";
import { VirtualItems } from "../VirtualItems";
import LazyMedia from "@/components/LazyMedia";
import { assetPreview, previewAttrs } from "@/lib/preview";

const PILL: Record<RigShotStatus, Status> = { approved: "approved", ready: "ready", queued: "queued", draft: "draft", failed: "failed" };

/** Stills stand in until real media exists; a take's own preview replaces them. */
export function ShotThumb({ id, asset, className = "pxw-rig-thumb" }: { id: string; asset: Asset | null; className?: string }) {
  const [c1, c2] = mediaBands(id);
  const full = assetPreview(asset);
  /* A video take is drawn from its own frame (the 640px preview route is for pictures); a picture from the preview route. */
  const preview = full?.kind === "video" ? null : asset?.generationId
    ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset?.uploadId ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}` : null;
  return (
    <span className={className} aria-hidden="true" {...previewAttrs(full)}>
      <span style={{ flex: 1, background: c1 }} />
      <span style={{ flex: 1.1, background: c2 }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : null}
      {full?.kind === "video" ? <span className="pxw-thumb-video"><LazyMedia url={full.url} kind="video" preview={false} /></span> : null}
    </span>
  );
}

function roleTone(status: RigShotStatus) {
  const agent = status === "ready" || status === "queued";
  return {
    dot: status === "approved" ? "var(--pxw-green)" : agent ? "var(--pxw-atomik-gold)" : "var(--pxw-label-floor)",
    color: agent ? "var(--pxw-atomik-gold-ink)" : "var(--pxw-dimmer)",
  };
}

/** Atomik's own annotation on a row, carried in the note slot's title. */
function annotation(shot: RigShot) {
  if (shot.status === "queued") return "Queued · rendering";
  if (shot.status === "ready") return "References resolved · quoted";
  return shot.issues.join(" ");
}

function Row({ shot, selected, onSelect, asset }: { shot: RigShot; selected: boolean; onSelect: () => void; asset: Asset | null }) {
  const tone = roleTone(shot.status);
  const note = shot.note || shot.issues[0] || "";
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      className="pxw-rig-row"
      aria-pressed={selected}
      data-shot-id={shot.id}
      data-ctx={`node:${shot.id}`}
      data-status={shot.status}
      data-drop={over || undefined}
      onClick={onSelect}
      /* Anything dropped on the row lands on this shot: an asset from anywhere, a brief, or files from the device (lib/shell/drop-targets). */
      onDragOver={(e) => { if (canDropOnShot(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); if (dropOnShot(e.dataTransfer, { nodeId: shot.id, name: shot.name })) e.preventDefault(); }}
    >
      <span className="pxw-rig-num">{String(shot.index).padStart(2, "0")}</span>
      <ShotThumb id={shot.id} asset={asset} />
      <span className="pxw-rig-shot">
        <span className="pxw-rig-name">{shot.name}</span>
        <span className="pxw-rig-role-line" title={annotation(shot)}>
          <span className="pxw-rig-role">
            <span className="pxw-dot" style={{ width: 5, height: 5, background: tone.dot }} />

          </span>
          <span className="pxw-rig-note">{note}</span>
        </span>
      </span>
      <span className="pxw-rig-look">{shot.look}</span>
      <span className="pxw-rig-engine">{shot.engine ? engineLabel(shot.engine).short : "—"}</span>
      <span className="pxw-rig-dur">{shot.durationS != null ? `${shot.durationS}s` : "—"}</span>
      <span className="pxw-rig-status"><StatusPill status={PILL[shot.status]} /></span>
    </button>
  );
}

/** Rig — shot list (the default view). */
export function RigList() {
  const rig = useRig();
  const { state } = useWorkspace();
  const { shots, project, selected } = rig;
  const load = rigLoadState({ status: rig.status, hasProject: !!project, projectId: state.projectId });
  return (
    <div className="pxw-rig-list" data-testid="rig-list" data-save-state={rig.saveState} data-section="rig-list">
      <div className="pxw-rig-head" role="presentation">
        <span className="pxw-rig-num" data-functional-label="">#</span>
        <span className="pxw-rig-thumb-col" />
        <span className="pxw-rig-shot" data-functional-label="">SHOT</span>
        <span className="pxw-rig-look" data-functional-label="">LOOK</span>
        <span className="pxw-rig-engine" data-functional-label="">ENGINE</span>
        <span className="pxw-rig-dur" data-functional-label="">DUR</span>
        <span className="pxw-rig-status" data-functional-label="">STATUS</span>
      </div>
      {load === "loading" ? (
        <p className="pxw-rig-empty" role="status">Loading shots…</p>
      ) : load === "error" ? (
        <p className="pxw-rig-empty" role="alert">{rig.error}</p>
      ) : load === "no-project" || !project ? (
        <p className="pxw-rig-empty">{RIG_NO_PROJECT}</p>
      ) : (
        <>
          <VirtualItems
            attrs={{ role: "list", "aria-label": "Shots" }} rowRole="listitem"
            items={shots} getKey={(shot) => shot.id} layout={{ columns: 1 }} gap={0} estimateRowHeight={58} scroll="ancestor"
            revealKey={selected?.id ?? null}
            renderItem={(shot) => <Row shot={shot} selected={selected?.id === shot.id} onSelect={() => rig.select(shot.id)} asset={shotPreviewAsset(project, shot.id)} />}
          />
          {!shots.length ? <p className="pxw-rig-empty">No shots yet. Add one to start.</p> : null}
          <button type="button" className="pxw-rig-add" onClick={rig.addShot}>+ Add shot</button>
          <BuildFromBoards />
          {rig.saveError ? <p className="pxw-rig-save-error" role="alert">{rig.saveError}</p> : null}
        </>
      )}
    </div>
  );
}
