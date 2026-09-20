"use client";
import { useMemo } from "react";
import { SOUND_TASKS, SOUND_TOOLS, type SoundJobTask } from "@/lib/workbench/sound-generate";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { assembly, mmss, stemRows, type StemRow } from "@/lib/workspace/stems";
import type { MobilePageProps } from "../screens/registry";

/**
 * Edit & Sound's own layout (05-mobile): the assembly card, the lanes, the five
 * generation doors and the edit versions.
 *
 * THE LANE COUNT IS THREE, NOT FOUR. The design draws four stems — dialogue,
 * effects, ambience, music — but the edit has three lanes
 * (lib/workbench/audio.ts), and an ambience bed is generated with the
 * sound-effects engine onto the effects lane. lib/workspace/stems.ts already
 * records that, the desktop page already shows three, and this screen keeps the
 * same truth and says so in a line rather than inventing a fourth lane that
 * nothing could fill.
 *
 * Everything else is derived: the assembly from the real sequence, each lane's
 * clips and length from the real audio clips, the doors from the real task and
 * tool definitions SoundGenerate opens, and the version rows from the draft the
 * server holds. Nothing here dispatches: a door is priced and composed by the
 * tool that owns it, and this page's plan runs them at its own gate.
 */

const STATE: Record<StemRow["state"], { label: string; dot: string }> = {
  empty: { label: "Empty", dot: "var(--pxw-label-floor)" },
  generating: { label: "Generating", dot: "var(--pxw-blue-ink)" },
  scored: { label: "Scored", dot: "var(--pxw-green)" },
};

const LANE_LABEL: Record<StemRow["id"], string> = { dialogue: "DIALOGUE", sfx: "SFX", music: "MUSIC" };

/** The unit each door is charged on, in SoundGenerate's own words. */
const UNIT: Record<SoundJobTask, string> = {
  speech: "Per character",
  sound: "One price per effect, up to 30 s",
  music: "Per minute, 10 s to 5 min",
  voiceChange: "Per started minute of the source",
  dub: "Per started minute of the source",
};

type Door = { id: SoundJobTask; name: string; desc: string; lane: string };

/** The five doors: the three generators, then the two tools on a stored take. */
export const DOORS: Door[] = [
  ...SOUND_TASKS.map((task): Door => ({ id: task.id, name: task.label, desc: task.field, lane: LANE_LABEL[task.lane] })),
  ...SOUND_TOOLS.map((tool): Door => ({ id: tool.id, name: tool.label, desc: "From a stored original in this project", lane: LANE_LABEL.dialogue })),
];

export function EditSoundPage({ project: shellProject, scope }: MobilePageProps) {
  const draft = useDraftEditor(scope, shellProject?.id ?? null);
  const project = draft.project;
  const rows = useMemo(() => (project ? stemRows(project) : []), [project]);
  const cut = useMemo(() => (project ? assembly(project) : null), [project]);

  if (!project || !cut) {
    return (
      <div className="pxm-pad-x pxm-pad-top" data-template="edit">
        {draft.state.error ? <p className="pxm-note" role="alert">{draft.state.error}</p> : null}
        <p className="pxm-empty" role="status">{shellProject ? "Loading the edit…" : "Open a project to see its edit."}</p>
      </div>
    );
  }

  return (
    <div className="pxm-pad-x pxm-pad-top" data-template="edit" data-testid="mobile-edit">
      <div className="pxm-card pxm-assembly" data-testid="mobile-assembly">
        <div className="pxm-grow">
          <span className="pxm-assembly-title">Assembly · {mmss(cut.seconds)}</span>
          <span className="pxm-assembly-sub">
            {cut.clips
              ? `${cut.clips.toLocaleString("en-US")} ${cut.clips === 1 ? "clip" : "clips"} in the sequence`
              : "No takes in the sequence yet. Add them from Takes."}
          </span>
        </div>
      </div>

      <div className="pxm-group-head pxm-form-head">
        <span className="pxm-kicker" data-functional-label="">LANES</span>
        <span className="pxm-group-note">three, as the edit has</span>
      </div>
      {rows.map((row) => {
        const s = STATE[row.state];
        return (
          <div className="pxm-lane" key={row.id} data-stem={row.id} data-state={row.state}>
            <span className="pxm-lane-bar" style={{ background: row.state === "empty" ? "var(--pxw-control-border)" : row.hue }} aria-hidden="true" />
            <span className="pxm-grow">
              <span className="pxm-row">
                <span className="pxm-grow pxm-lane-name">{row.name}</span>
                <span className="pxm-lane-tag" data-functional-label="">{LANE_LABEL[row.id]}</span>
              </span>
              <span className="pxm-lane-desc">{row.names.length ? row.names.join(" · ") : row.empty}</span>
              <span className="pxm-row pxm-lane-foot">
                <span className="pxm-dot5" style={{ background: s.dot }} aria-hidden="true" />
                <span className="pxm-lane-state">{s.label}</span>
                <span className="pxm-grow" />
                <span className="pxm-lane-clips" data-functional-label="">
                  {[
                    row.clips.length ? `${row.clips.length.toLocaleString("en-US")} ${row.clips.length === 1 ? "clip" : "clips"}` : null,
                    row.clips.length ? mmss(row.seconds) : null,
                    row.pending ? `${row.pending.toLocaleString("en-US")} generating` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </span>
          </div>
        );
      })}
      <p className="pxm-form-note">Ambience has no lane of its own: beds are generated as sound effects and sit on that lane.</p>

      <div className="pxm-group-head pxm-form-head">
        <span className="pxm-kicker" data-functional-label="">GENERATE ONTO A LANE</span>
        <span className="pxm-group-note">quoted first</span>
      </div>
      {DOORS.map((door) => (
        <div className="pxm-door" key={door.id} data-door={door.id}>
          <span className="pxm-grow">
            <span className="pxm-door-name">{door.name}</span>
            <span className="pxm-door-desc">{door.desc}</span>
          </span>
          <span className="pxm-door-right">
            <span className="pxm-door-unit" data-functional-label="">{UNIT[door.id]}</span>
            <span className="pxm-door-lane" data-functional-label="">→ {door.lane}</span>
          </span>
        </div>
      ))}
      <p className="pxm-form-note">
        Every door is quoted before anything is sent. This page’s plan runs them at its own approval gate, with the exact price on the button.
      </p>

      <div className="pxm-group-head pxm-form-head">
        <span className="pxm-kicker" data-functional-label="">EDIT VERSIONS</span>
      </div>
      <div className="pxm-versions">
        <div className="pxm-version-row">
          <span className="pxm-version-name">Assembly · current</span>
          <span className="pxm-version-value" data-functional-label="">live</span>
        </div>
        <div className="pxm-version-row">
          <span className="pxm-version-name">Saved revision</span>
          <span className="pxm-version-value" data-functional-label="">r{draft.state.revision.toLocaleString("en-US")}</span>
        </div>
        <div className="pxm-version-row">
          <span className="pxm-version-name">Sound on the cut</span>
          <span className="pxm-version-value" data-functional-label="">
            {rows.filter((row) => row.clips.length).length.toLocaleString("en-US")} of {rows.length.toLocaleString("en-US")} lanes
          </span>
        </div>
      </div>
    </div>
  );
}
