"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { suiteHref } from "@/lib/suites";
import { NODE_DEFS } from "@/lib/workbench/node-graph";
import { formatCredits, formatTokens } from "@/lib/workspace/cost";
import { engineLabel, shotEngine, shotEngines } from "@/lib/workspace/engines";
import { mediaBands } from "@/lib/workspace/format";
import { shotInputs, shotPreviewAsset, shotVersions, stepDuration } from "@/lib/workspace/rig";
import type { RigShot } from "@/lib/workspace/shots";
import { useShotEstimate } from "@/lib/workspace/use-shot-estimate";
import { useWorkspace } from "@/lib/workspace/state";
import type { InspTab } from "@/lib/workspace/types";
import { Field, Input, Kicker, Segmented, Select } from "../ui";
import { useRig } from "./RigProvider";
import "./rig.css";

/** The Inspector for a selected shot (03, "Inspector"). */
export function RigInspector() {
  const rig = useRig();
  const { selected, project } = rig;
  if (!project || !selected) {
    return (
      <div data-inspector-body="shot">
        <Kicker>Output</Kicker>
        <div className="pxw-preview" style={{ marginTop: 10 }} aria-hidden="true" />
        <p className="pxw-inspector-note">
          {rig.status === "loading" ? "Loading shots…" : project ? (rig.shots.length ? "Select a shot to see its controls." : "Add a shot to start.") : "Open a project to see its shots."}
        </p>
      </div>
    );
  }
  /* Keyed by shot so local field state never leaks between shots. */
  return <ShotInspector key={selected.id} shot={selected} />;
}

function Preview({ shot }: { shot: RigShot }) {
  const rig = useRig();
  const { state, dispatch } = useWorkspace();
  const asset = rig.project ? shotPreviewAsset(rig.project, shot.id) : null;
  const video = useRef<HTMLVideoElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const playable = asset?.kind === "video";
  const playing = playable && state.playing;
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (playing) void el.play().catch(() => dispatch({ type: "patch", patch: { playing: false } }));
    else el.pause();
  }, [playing, dispatch, asset?.url]);
  /* Leaving the shot stops playback. */
  useEffect(() => () => dispatch({ type: "patch", patch: { playing: false } }), [dispatch]);
  const [c1, c2] = mediaBands(shot.id);
  const imageSrc = asset?.kind === "image"
    ? asset.generationId ? `/api/workbench/preview/generation/${encodeURIComponent(asset.generationId)}` : asset.url
    : null;
  return (
    <>
      <div className="pxw-insp-output">
        <Kicker>Output</Kicker>
        <span className="pxw-insp-output-label">{asset ? `v${asset.version} · ${asset.kind === "video" ? "Take" : "Still"}` : "Still preview"}</span>
      </div>
      <div className="pxw-insp-preview" data-testid="shot-preview">
        {playable ? (
          <video
            ref={video}
            src={asset!.url}
            muted
            playsInline
            loop
            preload="metadata"
            onTimeUpdate={(e) => {
              const el = e.currentTarget;
              setPlayhead(el.duration ? (el.currentTime / el.duration) * 100 : 0);
            }}
            onPause={() => state.playing && dispatch({ type: "patch", patch: { playing: false } })}
          />
        ) : imageSrc ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={imageSrc} alt={asset!.name} />
        ) : (
          <>
            <span style={{ flex: 1, background: c1 }} />
            <span style={{ flex: 1.1, background: c2 }} />
          </>
        )}
        <span className="pxw-insp-playhead" aria-hidden="true"><span style={{ width: `${playable ? playhead : 0}%` }} /></span>
        <button
          type="button"
          className="pxw-insp-play"
          disabled={!playable}
          title={playable ? undefined : "Generate a take to play it here."}
          aria-keyshortcuts="Space"
          onClick={() => dispatch({ type: "patch", patch: { playing: !state.playing } })}
        >
          <span>{playing ? "Pause" : "Play"}</span>
          <span className="pxw-insp-play-key" aria-hidden="true">SPACE</span>
        </button>
      </div>
    </>
  );
}

function ShotInspector({ shot }: { shot: RigShot }) {
  const rig = useRig();
  const { state, dispatch } = useWorkspace();
  const project = rig.project!;
  const node = rig.selectedNode;
  const inputs = useMemo(() => shotInputs(project, shot.id), [project, shot.id]);
  const versions = useMemo(() => shotVersions(project, shot.id, rig.jobs), [project, shot.id, rig.jobs]);
  const tab = state.inspTab;
  const sub = [shot.look, shot.ratio, shot.durationS != null ? `${shot.durationS}s` : ""].filter(Boolean).join(" · ");
  return (
    <div data-inspector-body="shot" data-shot-id={shot.id}>
      <Preview shot={shot} />
      <div className="pxw-inspector-subject" data-testid="inspector-title">{shot.name}</div>
      <div className="pxw-inspector-sub">{sub}</div>
      <Segmented<InspTab>
        label="Inspector tabs"
        className="pxw-insp-tabs"
        border="field"
        fill
        value={tab}
        onChange={(inspTab) => dispatch({ type: "patch", patch: { inspTab } })}
        options={[
          { id: "Controls", label: "Controls" },
          { id: "Inputs", label: "Inputs", count: <span className="pxw-insp-tab-count" data-functional-label="">{inputs.length}</span> },
          { id: "Versions", label: "Versions", count: <span className="pxw-insp-tab-count" data-functional-label="">{versions.length}</span> },
        ]}
      />
      {tab === "Controls" ? <Controls shot={shot} locked={!!node?.locked} /> : null}
      {tab === "Inputs" ? (
        <div>
          <Kicker className="pxw-insp-section">Inputs</Kicker>
          {inputs.length ? inputs.map((row) => {
            const [c1, c2] = mediaBands(row.id);
            return (
              <div className="pxw-insp-row" key={row.id}>
                <span className="pxw-insp-row-thumb" aria-hidden="true"><span style={{ background: c1 }} /><span style={{ background: c2 }} /></span>
                <span className="pxw-insp-row-text">
                  <span className="pxw-insp-row-name">{row.name}</span>
                  <span className="pxw-insp-row-kind">{row.kind}</span>
                </span>
                <span className="pxw-insp-row-v" data-functional-label="">{row.version}</span>
              </div>
            );
          }) : <p className="pxw-inspector-note" style={{ marginTop: 0 }}>Nothing is connected to this shot yet.</p>}
          <div className="pxw-insp-add">
            <div>Add colour, transforms, masks or direction to this node.</div>
            <a href={suiteHref("particl", project.id, "canvas")}>+ Add a tool</a>
          </div>
        </div>
      ) : null}
      {tab === "Versions" ? (
        <div>
          <Kicker className="pxw-insp-section">Versions</Kicker>
          {versions.length ? versions.map((row) => (
            <div className="pxw-insp-version" key={row.id} data-current={row.current || undefined} data-state={row.state}>
              <span className="pxw-insp-version-v">{row.v}</span>
              <span className="pxw-insp-version-label">{row.label}</span>
              <span className="pxw-insp-version-meta">{row.meta}</span>
            </div>
          )) : <p className="pxw-inspector-note" style={{ marginTop: 0 }}>No takes yet. Generate one to start the version history.</p>}
        </div>
      ) : null}
    </div>
  );
}

function Controls({ shot, locked }: { shot: RigShot; locked: boolean }) {
  const rig = useRig();
  const project = rig.project!;
  const [name, setName] = useState(shot.name);
  const [error, setError] = useState<string | null>(null);
  const model = shotEngine(shot.engine);
  const estimate = useShotEstimate({ engine: shot.engine, durationS: shot.durationS, ratio: shot.ratio, resolution: shot.resolution });
  const looks = project.nodes.filter((n) => n.type === "moodboard");
  const lookValue = shot.lookNodeId ?? shot.look;
  const edit = (patch: Parameters<typeof rig.patchShot>[1]) => setError(rig.patchShot(shot.id, patch));
  const quote = rig.quote?.state === "ready" && rig.quote.credits !== null ? formatCredits(rig.quote.credits) : null;
  const durations = model?.durations ?? [];
  const range = durations.length ? { min: Math.min(...durations), max: Math.max(...durations) } : null;

  return (
    <div>
      <div className="pxw-insp-kicker-row">
        <Kicker>Node settings</Kicker>
        <span className="pxw-insp-owner">By {shot.role || NODE_DEFS[shot.nodeType].role}</span>
      </div>
      <div className="pxw-insp-fieldcard">
        <div className="pxw-insp-fieldcard-head">
          <span>Department</span>
          <span>Direction</span>
        </div>
        <textarea
          aria-label="Direction note"
          rows={3}
          value={shot.note}
          disabled={locked}
          placeholder="What should this shot do?"
          onChange={(e) => edit({ note: e.target.value })}
        />
      </div>
      <Field label="Name" className="pxw-insp-field">
        {(id) => (
          <Input
            id={id}
            value={name}
            disabled={locked}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim()) edit({ name: e.target.value });
              else setError("A shot needs a name.");
            }}
            onBlur={() => { if (!name.trim()) { setName(shot.name); setError(null); } }}
          />
        )}
      </Field>
      <div className="pxw-insp-pair">
        <Field label="Look" className="pxw-insp-field">
          {(id) => (
            <Select id={id} value={lookValue} disabled={locked} onChange={(e) => edit({ look: e.target.value })}>
              <option value="">No look</option>
              {looks.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
              {shot.look && !shot.lookNodeId ? <option value={shot.look}>{shot.look}</option> : null}
            </Select>
          )}
        </Field>
        <Field label="Ratio" className="pxw-insp-field">
          {(id) => (
            <Select id={id} value={shot.ratio} disabled={locked || !model} onChange={(e) => edit({ ratio: e.target.value })}>
              {(model?.ratios ?? [shot.ratio]).filter((r) => r !== "adaptive").map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          )}
        </Field>
      </div>

      <Kicker className="pxw-insp-section">Tool stack</Kicker>
      <Field label="Engine" className="pxw-insp-field">
        {(id) => (
          <Select id={id} value={model ? shot.engine : ""} disabled={locked} onChange={(e) => edit({ engine: e.target.value })}>
            {!model ? <option value="">Choose an engine</option> : null}
            {shotEngines().map((m) => <option key={m.id} value={m.id}>{engineLabel(m.id).long}</option>)}
          </Select>
        )}
      </Field>
      <div className="pxw-stepper pxw-insp-field">
        <span className="pxw-stepper-label">Duration</span>
        <span className="pxw-stepper-controls">
          <button type="button" className="pxw-stepper-btn" aria-label="Shorter" disabled={locked || !range || shot.durationS == null || shot.durationS <= range.min}
            onClick={() => edit({ durationS: stepDuration(durations, shot.durationS, -1) })}>−</button>
          <span className="pxw-stepper-value" data-testid="shot-duration" aria-live="polite">{shot.durationS != null ? `${shot.durationS}s` : "—"}</span>
          <button type="button" className="pxw-stepper-btn" aria-label="Longer" disabled={locked || !range || shot.durationS == null || shot.durationS >= range.max}
            onClick={() => edit({ durationS: stepDuration(durations, shot.durationS, 1) })}>+</button>
        </span>
      </div>
      <div className="pxw-insp-estimate" data-testid="shot-estimate" data-state={estimate.state}>
        <div className="pxw-insp-estimate-row">
          <span>Estimate</span>
          <span className="pxw-insp-estimate-value">{estimate.credits !== null ? formatCredits(estimate.credits) : estimate.state === "loading" ? "…" : "—"}</span>
        </div>
        <div className="pxw-insp-estimate-meta">
          {estimate.state === "unavailable" && estimate.reason
            ? estimate.reason
            : estimate.tokens !== undefined ? `${formatTokens(estimate.tokens)} · billed on settle` : "Billed on settle"}
        </div>
      </div>
      <button
        type="button"
        className="pxw-insp-generate"
        disabled={!!rig.blocked}
        title={rig.blocked ?? undefined}
        onClick={rig.generate}
      >
        {rig.submitting ? "Submitting…" : quote ? `Generate take · ${quote}` : "Generate take"}
      </button>
      {error ? <p className="pxw-insp-error" role="alert">{error}</p> : null}
      {!error && (rig.notice || rig.blocked) ? <p className="pxw-insp-notice" role="status">{rig.notice ?? rig.blocked}</p> : null}
    </div>
  );
}
