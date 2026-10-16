import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { fitFontSize } from "./lib/text";
import type { EndCardSpec, TitleCardSpec } from "./lib/types";
import { FONT_FAMILY } from "./fonts";

/** Fade and rise in over ~0.4 s, fade out over the last ~0.3 s. Frame-based, so it is the same at any fps. */
function useCardMotion(): { opacity: number; rise: number } {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const inFrames = Math.max(2, Math.round(fps * 0.4));
  const outFrames = Math.max(2, Math.round(fps * 0.3));
  const opacityIn = interpolate(frame, [0, inFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacityOut = interpolate(frame, [durationInFrames - outFrames, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return { opacity: Math.min(opacityIn, opacityOut), rise: interpolate(frame, [0, inFrames], [24, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) };
}

const Logo: React.FC<{ file: string; unit: number }> = ({ file, unit }) => (
  <Img src={staticFile(`input/${file}`)} style={{ maxHeight: 150 * unit, maxWidth: 520 * unit, objectFit: "contain", marginBottom: 56 * unit }} />
);

const frame = (background: string, foreground: string): React.CSSProperties => ({
  background,
  color: foreground,
  fontFamily: `${FONT_FAMILY}, system-ui, sans-serif`,
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
});

export const TitleCard: React.FC<{ card: TitleCardSpec }> = ({ card }) => {
  const { width, height } = useVideoConfig();
  const { opacity, rise } = useCardMotion();
  const unit = Math.min(width, height) / 1080;
  const column = width * 0.8;
  const titleSize = fitFontSize({ text: card.title, widthPx: column, maxPx: 150 * unit, minPx: 44 * unit, lines: height > width ? 4 : 2 });
  return (
    <AbsoluteFill style={frame(card.theme.background, card.theme.foreground)}>
      <div style={{ width: column, opacity, transform: `translateY(${rise * unit}px)`, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {card.logo ? <Logo file={card.logo.file} unit={unit} /> : null}
        <div style={{ fontSize: titleSize, fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.01em" }}>{card.title}</div>
        <div style={{ width: 120 * unit, height: 8 * unit, borderRadius: 4 * unit, background: card.theme.accent, margin: `${44 * unit}px 0` }} />
        {card.subtitle ? (
          <div style={{ fontSize: fitFontSize({ text: card.subtitle, widthPx: column, maxPx: 56 * unit, minPx: 28 * unit, lines: 2 }), fontWeight: 400, lineHeight: 1.25, opacity: 0.8 }}>{card.subtitle}</div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

export const EndCard: React.FC<{ card: EndCardSpec }> = ({ card }) => {
  const { width, height } = useVideoConfig();
  const { opacity, rise } = useCardMotion();
  const unit = Math.min(width, height) / 1080;
  const column = width * 0.8;
  return (
    <AbsoluteFill style={frame(card.theme.background, card.theme.foreground)}>
      <div style={{ width: column, opacity, transform: `translateY(${rise * unit}px)`, display: "flex", flexDirection: "column", alignItems: "center" }}>
        {card.logo ? <Logo file={card.logo.file} unit={unit} /> : null}
        <div style={{ fontSize: fitFontSize({ text: card.headline, widthPx: column, maxPx: 120 * unit, minPx: 40 * unit, lines: height > width ? 4 : 2 }), fontWeight: 700, lineHeight: 1.05 }}>{card.headline}</div>
        {card.callToAction ? (
          <div
            style={{
              marginTop: 56 * unit,
              padding: `${22 * unit}px ${56 * unit}px`,
              borderRadius: 999,
              background: card.theme.accent,
              color: card.theme.background,
              fontSize: fitFontSize({ text: card.callToAction, widthPx: column * 0.8, maxPx: 52 * unit, minPx: 26 * unit, lines: 1 }),
              fontWeight: 700,
            }}
          >
            {card.callToAction}
          </div>
        ) : null}
        {card.line ? <div style={{ marginTop: 44 * unit, fontSize: fitFontSize({ text: card.line, widthPx: column, maxPx: 44 * unit, minPx: 24 * unit, lines: 1 }), opacity: 0.8 }}>{card.line}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
