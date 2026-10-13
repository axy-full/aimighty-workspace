import React from "react";
import { AbsoluteFill, Html5Audio, OffthreadVideo, Sequence, interpolate, staticFile, useVideoConfig } from "remotion";
import { CaptionLayer } from "./CaptionLayer";
import { EndCard, TitleCard } from "./Cards";
import { reframeLayout } from "./lib/reframe";
import type { ClipTimelineItem, Timeline } from "./lib/types";

const place = (box: { x: number; y: number; width: number; height: number }): React.CSSProperties => ({
  position: "absolute",
  left: box.x,
  top: box.y,
  width: box.width,
  height: box.height,
  objectFit: "fill",
});

const Clip: React.FC<{ item: ClipTimelineItem }> = ({ item }) => {
  const { width, height } = useVideoConfig();
  const src = staticFile(`input/${item.file}`);
  const layout = reframeLayout({ srcW: item.sourceWidth, srcH: item.sourceHeight, outW: width, outH: height, reframe: item.reframe });
  return (
    <AbsoluteFill style={{ background: "#000000", overflow: "hidden" }}>
      {layout.backdrop ? (
        <AbsoluteFill style={{ filter: `blur(${Math.round(Math.min(width, height) / 18)}px)`, transform: "scale(1.08)", opacity: 0.7 }}>
          <OffthreadVideo src={src} trimBefore={item.trimBefore} muted style={place(layout.backdrop)} />
        </AbsoluteFill>
      ) : null}
      <OffthreadVideo src={src} trimBefore={item.trimBefore} volume={item.hasAudio ? 1 : 0} muted={!item.hasAudio} style={place(layout.video)} />
      {item.captionStyle && item.cues.length ? <CaptionLayer cues={item.cues} style={item.captionStyle} /> : null}
    </AbsoluteFill>
  );
};

/** Renders any composition's timeline: cards and clips in order, with the music underneath. */
export const TimelineView: React.FC<{ timeline: Timeline }> = ({ timeline }) => {
  const { fps } = timeline;
  const fade = Math.round(fps);
  const music = timeline.music;
  return (
    <AbsoluteFill style={{ background: "#000000" }}>
      {timeline.items.map((item, index) => (
        <Sequence key={index} from={item.from} durationInFrames={item.durationInFrames} layout="none">
          {item.kind === "clip" ? <Clip item={item} /> : item.kind === "title" ? <TitleCard card={item.card} /> : <EndCard card={item.card} />}
        </Sequence>
      ))}
      {music ? (
        <Sequence from={0} durationInFrames={music.durationInFrames} layout="none">
          <Html5Audio
            src={staticFile(`input/${music.file}`)}
            volume={(f) => music.volume * interpolate(f, [music.durationInFrames - fade, music.durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
          />
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
