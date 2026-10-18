import type { Box, ReframeSpec } from "./types";

export type ReframeLayout = {
  /** Where the video sits in the output frame (may extend past it when filling). */
  video: Box;
  /** For "fit": a blown-up copy behind the video, so the bars are not black. */
  backdrop: Box | null;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Place a source of srcW x srcH into an output frame of outW x outH.
 *
 * "fill" scales until the frame is covered and crops the rest, centred on the focus point
 * (0..1 across the source; the crop never leaves the picture). "fit" shows the whole picture
 * and fills the bars with a blurred, filled copy. Same shape in and out: both are the identity.
 */
export function reframeLayout(input: { srcW: number; srcH: number; outW: number; outH: number; reframe: ReframeSpec }): ReframeLayout {
  const { srcW, srcH, outW, outH, reframe } = input;
  const cover = Math.max(outW / srcW, outH / srcH);
  const filled: Box = (() => {
    const width = srcW * cover;
    const height = srcH * cover;
    return {
      x: round2(clamp(outW / 2 - reframe.focusX * width, outW - width, 0)),
      y: round2(clamp(outH / 2 - reframe.focusY * height, outH - height, 0)),
      width: round2(width),
      height: round2(height),
    };
  })();
  if (reframe.mode === "fill") return { video: filled, backdrop: null };
  const contain = Math.min(outW / srcW, outH / srcH);
  const width = srcW * contain;
  const height = srcH * contain;
  const sameShape = Math.abs(width - outW) < 0.5 && Math.abs(height - outH) < 0.5;
  return {
    video: { x: round2((outW - width) / 2), y: round2((outH - height) / 2), width: round2(width), height: round2(height) },
    backdrop: sameShape ? null : { x: filled.x, y: filled.y, width: filled.width, height: filled.height },
  };
}
