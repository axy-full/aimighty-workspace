import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { FixtureClip } from "./Fixture";
import { TimelineView } from "./TimelineView";
import { loadFonts } from "./fonts";
import { validateProps } from "./lib/validate";
import { toTimeline } from "./lib/timeline";
import { DEFAULT_THEME, type CompositionId, type PropsById, type ClipItem, type ReframeSpec, type ClipSource } from "./lib/types";

loadFonts();

const FILL: ReframeSpec = { mode: "fill", focusX: 0.5, focusY: 0.5 };
const SOURCE: ClipSource = { file: "sample.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true };
const CLIP: ClipItem = { source: SOURCE, cues: [], reframe: FILL };
const COMMON = { aspect: "16:9", fps: 30, scale: 1 } as const;

/** Defaults only name the shape for the studio; every real render passes its own validated props. */
const DEFAULTS: PropsById = {
  "title-card": { ...COMMON, card: { title: "Title", theme: DEFAULT_THEME, durationSeconds: 2.5 } },
  "end-card": { ...COMMON, card: { headline: "Thank you", theme: DEFAULT_THEME, durationSeconds: 3 } },
  captions: { ...COMMON, clip: CLIP, captionStyle: "bold" },
  reframe: { ...COMMON, aspect: "9:16", clip: CLIP },
  cutdown: { ...COMMON, source: SOURCE, targetSeconds: 6, keep: [], cues: [], captionStyle: null, reframe: FILL },
  final: { ...COMMON, title: null, clips: [CLIP], captionStyle: null, end: null, music: null, voiceover: [], duck: 0.3 },
  "fixture-clip": { ...COMMON, durationSeconds: 2, label: "SAMPLE" },
};

function metadata<K extends CompositionId>(id: K): CalculateMetadataFunction<PropsById[K]> {
  return ({ props }) => {
    const checked = validateProps(id, props);
    if (!checked.ok) throw new Error(`Invalid props for ${id}: ${checked.errors.join("; ")}`);
    const timeline = toTimeline(id, checked.value);
    return { durationInFrames: timeline.durationInFrames, fps: timeline.fps, width: timeline.width, height: timeline.height, props: checked.value };
  };
}

function makeView<K extends CompositionId>(id: K): React.FC<PropsById[K]> {
  const View: React.FC<PropsById[K]> = (props) => {
    const timeline = toTimeline(id, props);
    return timeline.fixture ? <FixtureClip label={timeline.fixture.label} /> : <TimelineView timeline={timeline} />;
  };
  View.displayName = `Export-${id}`;
  return View;
}

const VIEWS = {
  "title-card": makeView("title-card"),
  "end-card": makeView("end-card"),
  captions: makeView("captions"),
  reframe: makeView("reframe"),
  cutdown: makeView("cutdown"),
  final: makeView("final"),
  "fixture-clip": makeView("fixture-clip"),
};

function entry<K extends CompositionId>(id: K) {
  const view = VIEWS[id] as React.FC<PropsById[K]>;
  const t = toTimeline(id, DEFAULTS[id]);
  return (
    <Composition
      key={id}
      id={id}
      component={view as unknown as React.FC<Record<string, unknown>>}
      width={t.width}
      height={t.height}
      fps={t.fps}
      durationInFrames={t.durationInFrames}
      defaultProps={DEFAULTS[id] as unknown as Record<string, unknown>}
      calculateMetadata={metadata(id) as unknown as CalculateMetadataFunction<Record<string, unknown>>}
    />
  );
}

export const Root: React.FC = () => (
  <>
    {entry("title-card")}
    {entry("end-card")}
    {entry("captions")}
    {entry("reframe")}
    {entry("cutdown")}
    {entry("final")}
    {entry("fixture-clip")}
  </>
);
