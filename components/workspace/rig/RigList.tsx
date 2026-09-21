"use client";
import { useState } from "react";
import type { Asset } from "@/lib/workbench/studio";
import { engineLabel } from "@/lib/workspace/engines";
import { mediaBands } from "@/lib/workspace/format";
import { shotPreviewAsset } from "@/lib/workspace/rig";
import type { RigShot, RigShotStatus } from "@/lib/workspace/shots";
import { StatusPill, type Status } from "../ui";
import { useRig } from "./RigProvider";
import { shotDropHandler } from "@/lib/shell/drop-targets";

const PILL: Record<RigShotStatus, Status> = { approved: "approved", ready: "ready", queued: "queued", draft: "draft", failed: "failed" };

/** Stills stand in until real media exists; a take's own preview replaces them. */
export function ShotThumb({ id, asset, className = "pxw-rig-thumb" }: { id: string; asset: Asset | null; className?: string }) {
  const [c1, c2] = mediaBands(id);
  const preview = asset?.generationId
    ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset?.uploadId ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}` : null;
  return (
    <span className={className} aria-hidden="true">
      <span style={{ flex: 1, background: c1 }} />
      <span style={{ flex: 1.1, background: c2 }} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : null}
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

function Row({ shot, selected, onSelect, asset, onDropAsset }: { shot: RigShot; selected: boolean; onSelect: () => void; asset: Asset | null; onDropAsset?: (assetId: string, shot: { nodeId: string; name: string }) => void }) {
  const tone = roleTone(shot.status);
  const note = shot.note || shot.issues[0] || "";
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      className="pxw-rig-row"
      aria-pressed={selected}
      data-shot-id={shot.id}
      data-status={shot.status}
      data-drop={over || undefined}
      onClick={onSelect}
      /* A Library asset dropped on the row is filed on this shot (text/plain = asset id). */
      onDragOver={onDropAsset ? (e) => { if (e.dataTransfer.types.includes("text/plain")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setOver(true); } } : undefined}
      onDragLeave={onDropAsset ? () => setOver(false) : undefined}
      onDrop={onDropAsset ? (e) => { e.preventDefault(); setOver(false); const id = e.dataTransfer.getData("text/plain"); if (id) onDropAsset(id, { nodeId: shot.id, name: shot.name }); } : undefined}
    >
      <span className="pxw-rig-num">{String(shot.index).padStart(2, "0")}</span>
      <ShotThumb id={shot.id} asset={asset} />
      <span className="pxw-rig-shot">
        <span className="pxw-rig-name">{shot.name}</span>
        <span className="pxw-rig-role-line" title={annotation(shot)}>
          <span className="pxw-rig-role">
            <span className="pxw-dot" style={{ width: 5, height: 5, background: tone.dot }} />
            <span style={{ color: tone.color }}>{shot.role}</span>
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
  const { shots, project, selected } = rig;
  return (
    <div className="pxw-rig-list" data-testid="rig-list" data-save-state={rig.saveState}>
      <div className="pxw-rig-head" role="presentation">
        <span className="pxw-rig-num" data-functional-label="">#</span>
        <span className="pxw-rig-thumb-col" />
        <span className="pxw-rig-shot" data-functional-label="">SHOT</span>
        <span className="pxw-rig-look" data-functional-label="">LOOK</span>
        <span className="pxw-rig-engine" data-functional-label="">ENGINE</span>
        <span className="pxw-rig-dur" data-functional-label="">DUR</span>
        <span className="pxw-rig-status" data-functional-label="">STATUS</span>
      </div>
      {rig.status === "loading" || (rig.status === "idle" && !project) ? (
        <p className="pxw-rig-empty">Loading shots…</p>
      ) : rig.status === "error" ? (
        <p className="pxw-rig-empty" role="alert">{rig.error}</p>
      ) : !project ? (
        <p className="pxw-rig-empty">Open a project to see its shots.</p>
      ) : (
        <>
          <div role="list" aria-label="Shots">
            {shots.map((shot) => (
              <div role="listitem" key={shot.id}>
                <Row shot={shot} selected={selected?.id === shot.id} onSelect={() => rig.select(shot.id)} asset={shotPreviewAsset(project, shot.id)} onDropAsset={shotDropHandler() ?? undefined} />
              </div>
            ))}
          </div>
          {!shots.length ? <p className="pxw-rig-empty">No shots yet. Add one to start.</p> : null}
          <button type="button" className="pxw-rig-add" onClick={rig.addShot}>+ Add shot</button>
          {rig.saveError ? <p className="pxw-rig-save-error" role="alert">{rig.saveError}</p> : null}
        </>
      )}
    </div>
  );
}
