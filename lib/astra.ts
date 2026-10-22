import { RESOLUTION_SHORT_SIDE } from "./models";

export const ASTRA_MODEL = "topaz/upscale/video/creative";
/** The short side of what the video upscale makes: the code's own 4K tier (lib/models.ts), the one it is quoted at and asked for. */
export const ASTRA_OUTPUT_SHORT_SIDE = RESOLUTION_SHORT_SIDE["4k"];
/**
 * A clip already at that size has nothing to upscale (owner, 21 Oct 2026: "4K: free only if the takes were made and billed at 4K;
 * otherwise priced as the upscale it is"). Measured from the original, never from a label: admission refuses it before any quote,
 * hold or charge, and dispatch refuses one that was held before this rule. Plain words, no engine named. The line's wording and the
 * threshold at the 4K tier itself (a 2150-2159 px short side, sent at a rounded 1.00x, is still priced) are the owner's (21 Oct 2026).
 */
export const ALREADY_4K = "This clip is already 4K: nothing to upscale.";
/** The refusal's code, so a screen can show the line in place of a price. */
export const ALREADY_4K_CODE = "already_4k";
export function alreadyAt4K(source: { width: number; height: number }): boolean {
  const short = Math.min(source.width, source.height);
  return Number.isFinite(short) && short >= ASTRA_OUTPUT_SHORT_SIDE;
}
export type AstraSettings = {
  creativity: number;
  realism: number;
  sharpness: number;
  fps: 30 | 60;
};
export const DEFAULT_ASTRA: AstraSettings = {
  creativity: 0.5,
  realism: 0.5,
  sharpness: 0.5,
  fps: 30,
};
export function astraSettings(value: unknown): AstraSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Choose the Topaz Astra output settings before reviewing its cost.",
    );
  const input = value as Record<string, unknown>;
  if (
    !([30, 60] as unknown[]).includes(input.fps) ||
    ![input.creativity, input.realism, input.sharpness].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
    )
  )
    throw new Error(
      "Use 30 or 60 fps and Topaz Astra detail settings between 0 and 1.",
    );
  return {
    creativity: input.creativity as number,
    realism: input.realism as number,
    sharpness: input.sharpness as number,
    fps: input.fps as 30 | 60,
  };
}
export function astraInput(
  url: string,
  value: AstraSettings,
  sourceHeight: number,
) {
  const settings = astraSettings(value);
  if (!Number.isFinite(sourceHeight) || sourceHeight <= 0)
    throw new Error("The original source dimensions are required for Topaz Astra.");
  return {
    video_url: url,
    upscale_factor: Math.min(
      4,
      Math.max(1, Math.round((ASTRA_OUTPUT_SHORT_SIDE / sourceHeight) * 100) / 100),
    ),
    creativity: settings.creativity,
    realism: settings.realism,
    sharp: settings.sharpness,
    target_fps: settings.fps,
    H264_output: true,
  };
}
