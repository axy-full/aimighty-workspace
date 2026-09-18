"use client";

import { useEffect, useRef } from "react";
import type { Project } from "@/lib/workbench/studio";
import {
  normalizeReferenceAd,
  referenceAdOriginals,
  selectReferenceAd,
  type ReferenceAdConfig,
} from "@/lib/workbench/reference-ad";

/** Standalone reference review. Parent owns persistence; this component never submits media. */
export function ReferenceAd({ project, enabled, value, onChange }: {
  project: Project;
  enabled: boolean;
  value: ReferenceAdConfig;
  onChange: (value: ReferenceAdConfig) => void;
}) {
  const originals = referenceAdOriginals(project);
  const selected = originals.find((item) => item.asset.id === value.assetId);
  const missing = Boolean(value.assetId && !selected);
  const notified = useRef<string | null>(null);

  useEffect(() => {
    if (!missing) { notified.current = null; return; }
    if (!enabled) return;
    const key = JSON.stringify([project.id, value.assetId]);
    if (notified.current === key) return;
    notified.current = key;
    onChange(normalizeReferenceAd(project, value));
  }, [enabled, missing, onChange, project, value]);

  return <section className="suite-panel" aria-label="Reference ad">
    <div className="suite-section-heading">
      <div>
        <h2>Reference ad</h2>
        <p>Choose a project video and describe the creative choices you want to carry into your campaign.</p>
      </div>
      <span className="suite-badge">Creative reference</span>
    </div>
    <fieldset disabled={!enabled} className="suite-fields">
      <label>
        Reference video
        <select aria-label="Reference ad video" value={selected?.asset.id ?? ""} onChange={(event) => onChange(selectReferenceAd(project, value, event.target.value))}>
          <option value="">No reference selected</option>
          {originals.map(({ asset }) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
        </select>
      </label>
      <label>
        What works in this ad
        <textarea aria-label="Reference ad notes" rows={3} maxLength={2000} value={value.notes} placeholder="Describe the opening, pacing, framing or sound you want to learn from." onChange={(event) => onChange({ ...normalizeReferenceAd(project, value), notes: event.target.value })}/>
      </label>
      <label>
        Direction for your campaign
        <textarea aria-label="Reference ad matching direction" rows={4} maxLength={6000} value={value.direction} placeholder="Explain which choices to adapt and how your product, brand and message should differ." onChange={(event) => onChange({ ...normalizeReferenceAd(project, value), direction: event.target.value })}/>
      </label>
    </fieldset>
    {missing && <p role="status">The selected original is unavailable. Choose another project video.</p>}
    {!originals.length && <p>No stored project videos are available. Upload a video or add a generated take to the project asset library.</p>}
    <p style={{ fontSize: 12, color: "#9298a0", lineHeight: 1.7 }}>Video references use a compatible Particl engine, such as Seedance. Review its source-duration limits and credit quote before generating. Your notes provide creative direction; this does not analyze the ad.</p>
    {selected && <figure style={{ margin: "20px 0 0" }}>
      <video key={`${project.id}:${selected.asset.id}:${selected.original.url}`} aria-label={`Reference ad preview: ${selected.asset.name}`} src={selected.original.url} controls playsInline preload="metadata" style={{ display: "block", width: "100%", maxHeight: 420, background: "#000", borderRadius: 12 }}/>
      <figcaption style={{ marginTop: 8, fontSize: 12 }}>{selected.asset.name} · Original project video</figcaption>
    </figure>}
  </section>;
}
