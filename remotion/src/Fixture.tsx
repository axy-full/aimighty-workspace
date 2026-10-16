import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_FAMILY } from "./fonts";

/**
 * Our own sample picture: a moving gradient, a bar sweeping across and the frame number.
 * Used as the input clip in tests and in the timing run, so no outside media and no engine is needed.
 */
export const FixtureClip: React.FC<{ label: string }> = ({ label }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames, fps } = useVideoConfig();
  const unit = Math.min(width, height) / 1080;
  const t = frame / Math.max(1, durationInFrames - 1);
  const sweep = interpolate(t, [0, 1], [0, width - 160 * unit]);
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${Math.round(120 + t * 120)}deg, hsl(${Math.round(t * 300)}, 70%, 32%), hsl(${Math.round(200 + t * 120)}, 75%, 22%))`,
        fontFamily: `${FONT_FAMILY}, system-ui, sans-serif`,
        color: "#ffffff",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div style={{ position: "absolute", left: sweep, top: 0, width: 160 * unit, height: "100%", background: "rgba(255,255,255,0.18)" }} />
      <div style={{ fontSize: 160 * unit, fontWeight: 800 }}>{label}</div>
      <div style={{ fontSize: 56 * unit, opacity: 0.8 }}>{`${(frame / fps).toFixed(2)} s`}</div>
    </AbsoluteFill>
  );
};
