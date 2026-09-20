"use client";
import { engineLabel, shotEngine } from "@/lib/workspace/engines";
import { mediaBands } from "@/lib/workspace/format";
import { shotPreviewAsset } from "@/lib/workspace/rig";
import type { RigShot, RigShotStatus } from "@/lib/workspace/shots";
import { useWorkspace } from "@/lib/workspace/state";
import type { Asset } from "@/lib/workbench/studio";
import { STATUS, type Status } from "../../ui/StatusPill";
import { useRig } from "../../rig/RigProvider";

/**
 * Shot list (05-mobile, template 1): a 62×40 thumb carrying the shot number,
 * then the name, the note, the status chip and `engine · dur · look` in mono.
 *
 * The data is the desktop Rig's, unchanged: `useRig` derives it with
 * lib/workspace/shots.ts from the real draft graph and the real job list, so
 * the phone and the desktop cannot list different shots. Tapping a shot selects
 * it through the Rig's own `select` — which repairs the URL — and opens the
 * Inspector sheet, the phone's replacement for the desktop's right rail.
 */

const PILL: Record<RigShotStatus, Status> = { approved: "approved", ready: "ready", queued: "queued", draft: "draft", failed: "failed" };

function Thumb({ id, index, asset }: { id: string; index: number; asset: Asset | null }) {
  const [c1, c2] = mediaBands(id);
  const preview = asset?.generationId
    ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}`
    : asset?.uploadId
      ? `/api/workbench/preview/upload/${encodeURIComponent(asset.uploadId)}`
      : null;
  return (
    <span className="pxm-shot-thumb">
      <span className="pxm-shot-band-a" style={{ background: c1 }} aria-hidden="true" />
      <span className="pxm-shot-band-b" style={{ background: c2 }} aria-hidden="true" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview ? <img src={preview} alt="" loading="lazy" decoding="async" /> : null}
      <span className="pxm-shot-num" data-functional-label="">{String(index).padStart(2, "0")}</span>
    </span>
  );
}

/**
 * `2.5 · 6s · Desert daylight` — every part from the shot, nothing invented.
 * An engine the catalogue no longer lists is left out rather than printed as
 * the generic fallback: the row's Draft state and the Inspector say what is
 * wrong, and a name nobody can render with is not a name.
 */
export function shotMeta(shot: RigShot): string {
  const engine = shotEngine(shot.engine);
  return [engine ? engineLabel(engine.id).short : null, shot.durationS != null ? `${shot.durationS}s` : null, shot.look || null]
    .filter(Boolean)
    .join(" · ");
}

export function ShotListPage() {
  const ws = useWorkspace();
  const rig = useRig();
  const { shots, project, selected } = rig;

  if (rig.status === "loading" || (rig.status === "idle" && !project)) return <p className="pxm-empty pxm-pad-x">Loading shots…</p>;
  if (rig.status === "error") return <p className="pxm-empty pxm-pad-x" role="alert">{rig.error}</p>;
  if (!project) return <p className="pxm-empty pxm-pad-x">Open a project to see its shots.</p>;

  return (
    <div className="pxm-pad-x pxm-pad-top pxm-rows" data-template="shots" data-testid="mobile-shot-list">
      {rig.saveError ? <p className="pxm-empty" role="alert">{rig.saveError}</p> : null}
      {shots.map((shot) => {
        const pill = STATUS[PILL[shot.status]];
        const note = shot.note || shot.issues[0] || "";
        return (
          <button
            key={shot.id}
            type="button"
            className="pxm-shot-row"
            data-shot-id={shot.id}
            data-status={shot.status}
            aria-pressed={selected?.id === shot.id}
            onClick={() => {
              rig.select(shot.id);
              ws.setSheet("inspector");
            }}
          >
            <Thumb id={shot.id} index={shot.index} asset={shotPreviewAsset(project, shot.id)} />
            <span className="pxm-grow">
              <span className="pxm-shot-name">{shot.name}</span>
              {note ? <span className="pxm-shot-note">{note}</span> : null}
              <span className="pxm-row pxm-shot-foot">
                <span className="pxm-status-chip" style={{ background: pill.bg }}>
                  <span className="pxm-dot5" style={{ background: pill.dot }} aria-hidden="true" />
                  <span className="pxm-status-chip-label" style={{ color: pill.color }}>{pill.label}</span>
                </span>
                <span className="pxm-shot-meta" data-functional-label="">{shotMeta(shot)}</span>
              </span>
            </span>
          </button>
        );
      })}
      {!shots.length ? <p className="pxm-empty">No shots yet. Add one to start.</p> : null}
      <button type="button" className="pxm-dashed" data-testid="mobile-add-shot" onClick={rig.addShot}>
        + Add shot
      </button>
    </div>
  );
}
