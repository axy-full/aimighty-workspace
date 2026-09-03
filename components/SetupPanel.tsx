"use client";

/**
 * What every render in this project carries with it: which shot it files
 * against, the shot control chips, and the cast. Kept beside the wall on a
 * desk, below it on a phone, and hidden with one tap when the work wants
 * the whole width.
 */
import ShotRow from "./ShotRow";
import Studio from "./Studio";
import Cast from "./Cast";
import { IconClose } from "./Icons";
import type { ShotSpec } from "@/lib/studio";

export default function SetupPanel({
  projectId, shotId, setShotId, spec, setSpec, onCite, onClose, look, onClearLook,
}: {
  projectId: string;
  shotId: string; setShotId: (id: string) => void;
  spec: ShotSpec; setSpec: (s: ShotSpec) => void;
  onCite: (token: string) => void;
  onClose?: () => void;
  look?: { id: string; name: string } | null;
  onClearLook?: () => void;
}) {
  return (
    <div className="setup-inner">
      <div className="setup-head">
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Setup</span>
        <span className="text-[12.5px] text-mute">carried into every shot</span>
        {onClose && (
          <button type="button" onClick={onClose} className="setup-close" title="Hide setup">
            <IconClose />
          </button>
        )}
      </div>
      <ShotRow projectId={projectId} shotId={shotId} setShotId={setShotId} />
      <div className="mt-3"><Studio spec={spec} setSpec={setSpec} look={look} onClearLook={onClearLook} /></div>
      <div className="mt-3"><Cast projectId={projectId} onCite={onCite} /></div>
    </div>
  );
}
