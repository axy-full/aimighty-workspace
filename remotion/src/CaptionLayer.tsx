import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { captionAt, frameToMs } from "./lib/captions";
import { CAPTION_CHARS } from "./lib/text";
import { DEFAULT_THEME, type CaptionStyle, type Cue } from "./lib/types";
import { FONT_FAMILY } from "./fonts";

/** Burned-in captions for one clip. Cues are in the clip's own time. */
export const CaptionLayer: React.FC<{ cues: Cue[]; style: CaptionStyle }> = ({ cues, style }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const tall = height > width;
  const now = captionAt(cues, frameToMs(frame, fps), tall ? CAPTION_CHARS["9:16"] : CAPTION_CHARS["16:9"]);
  if (!now) return null;
  const unit = Math.min(width, height) / 1080;
  // A tall frame keeps captions clear of the platform's own buttons and text.
  const bottom = height * (tall ? 0.22 : 0.1);
  const sincePage = frame - Math.round((now.pageStartMs * fps) / 1000);
  const pop = interpolate(sincePage, [0, Math.max(2, Math.round(fps * 0.12))], [0.92, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const accent = DEFAULT_THEME.accent;

  const base: React.CSSProperties = {
    fontFamily: `${FONT_FAMILY}, system-ui, sans-serif`,
    textAlign: "center",
    lineHeight: 1.12,
    maxWidth: width * 0.86,
    transform: `scale(${pop})`,
  };
  const words = now.words.map((word, index) => {
    const active = style === "karaoke" && index === now.activeWord;
    return (
      <span key={index} style={{ display: "inline-block", margin: `0 ${0.14}em`, color: active ? accent : "#ffffff", opacity: style === "karaoke" && index > now.activeWord ? 0.7 : 1 }}>
        {style === "bold" ? word.toUpperCase() : word}
      </span>
    );
  });
  const styles: Record<CaptionStyle, React.CSSProperties> = {
    bold: { ...base, fontSize: 78 * unit, fontWeight: 800, WebkitTextStroke: `${9 * unit}px #000000`, paintOrder: "stroke fill", textShadow: `0 ${4 * unit}px ${16 * unit}px rgba(0,0,0,0.5)` },
    karaoke: { ...base, fontSize: 74 * unit, fontWeight: 800, WebkitTextStroke: `${8 * unit}px #000000`, paintOrder: "stroke fill", textShadow: `0 ${4 * unit}px ${16 * unit}px rgba(0,0,0,0.5)` },
    clean: { ...base, fontSize: 46 * unit, fontWeight: 500, background: "rgba(0,0,0,0.62)", padding: `${14 * unit}px ${30 * unit}px`, borderRadius: 16 * unit },
  };
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: bottom }}>
      <div style={styles[style]}>{words}</div>
    </AbsoluteFill>
  );
};
