"use client";

/**
 * The two rail blocks under the composer, from the pipeline handoff.
 *
 * SETUP is what every render in this production carries with it: the shot
 * control choices, shown back as a two-column key/value list rather than a
 * sentence — Shot size / Angle / Move / Lens / Lighting / Time of day /
 * Look / Mood — with an unset row reading a faint dash. It is edited in the
 * Studio's shot builder, so the block links there instead of growing its
 * own chip wall. The audio desk shows the sound half of the same setup, so
 * the block takes its rows as a prop.
 *
 * CAST is who can be written into a prompt by name: the production's
 * characters, locations, props and looks as chips, each a striped thumb,
 * `@Name` and its kind in mono. Clicking one cites it.
 */
import Link from "next/link";
import { CATEGORIES, type ShotSpec } from "@/lib/studio";
import Cast from "./Cast";

export type SetupRow = { key: string; label: string };

/** The video composer's rows: the eight axes a render carries. */
export const VIDEO_ROWS: SetupRow[] = [
  { key: "size", label: "Shot size" }, { key: "angle", label: "Angle" },
  { key: "move", label: "Move" }, { key: "lens", label: "Lens" },
  { key: "light", label: "Lighting" }, { key: "time", label: "Time of day" },
  { key: "look", label: "Look" }, { key: "mood", label: "Mood" },
];

/** The audio desk's rows: the sound half of the same setup. */
export const AUDIO_ROWS: SetupRow[] = [
  { key: "sound", label: "Sound" }, { key: "mood", label: "Mood" },
  { key: "time", label: "Time of day" }, { key: "titles", label: "Titles" },
];

/** The category's chip label for a stored value, or null when unset. */
function labelFor(key: string, value: string | undefined): string | null {
  if (!value) return null;
  const cat = CATEGORIES.find((c) => c.key === key)
    ?? CATEGORIES.find((c) => c.label.toLowerCase().startsWith(key.slice(0, 4)));
  return cat?.options.find((o) => o.value === value)?.label ?? value;
}

/** The Setup block alone: title, mono eyebrow, the Studio link, the rows. */
export function SetupBlock({ spec, rows = VIDEO_ROWS, eyebrow = "Carried into every shot" }: {
  spec: ShotSpec; rows?: SetupRow[]; eyebrow?: string;
}) {
  /* The stored keys are the categories' own keys; map by category label so
     a rename on either side still finds its row. */
  const shown = rows.map((r) => {
    const cat = CATEGORIES.find((c) => c.label === r.label)
      ?? CATEGORIES.find((c) => c.label.toLowerCase().startsWith(r.label.toLowerCase()));
    const value = cat ? spec[cat.key] : undefined;
    return { ...r, value: cat ? labelFor(cat.key, value) : null };
  });
  return (
    <div className="ws-block">
      <div className="ws-block-head">
        <span className="ws-block-title">Setup <span className="mono">{eyebrow}</span></span>
        <Link href="/studio/shot" className="hdr-mono-link">EDIT IN STUDIO →</Link>
      </div>
      <div className="kv">
        {shown.map((r) => (
          <div key={r.key} className="kv-row">
            <span>{r.label}</span>
            <span className={r.value ? "" : "is-unset"}>{r.value ?? "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SetupPanel({ projectId, spec, onCite }: {
  projectId: string;
  spec: ShotSpec;
  onCite: (token: string) => void;
  /* Kept for the callers that still pass them; the rail has no shot row of
     its own (the filing chip lives in the rail head) and no close button. */
  shotId?: string; setShotId?: (id: string) => void;
  setSpec?: (s: ShotSpec) => void; onClose?: () => void;
}) {
  return (
    <>
      <SetupBlock spec={spec} />
      <div className="ws-block">
        <div className="ws-block-head">
          <span className="ws-block-title">Cast <span className="mono">Write @name in any prompt</span></span>
        </div>
        <Cast projectId={projectId} onCite={onCite} chips />
      </div>
    </>
  );
}
