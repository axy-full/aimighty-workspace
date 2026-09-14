export const ASTRA_MODEL = "topaz/upscale/video/creative";
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
      "Choose the Astra output settings before reviewing its cost.",
    );
  const input = value as Record<string, unknown>;
  if (
    !([30, 60] as unknown[]).includes(input.fps) ||
    ![input.creativity, input.realism, input.sharpness].every(
      (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
    )
  )
    throw new Error(
      "Use 30 or 60 fps and Astra detail settings between 0 and 1.",
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
    throw new Error("The original source dimensions are required for Astra.");
  return {
    video_url: url,
    upscale_factor: Math.min(
      4,
      Math.max(1, Math.round((2160 / sourceHeight) * 100) / 100),
    ),
    creativity: settings.creativity,
    realism: settings.realism,
    sharp: settings.sharpness,
    target_fps: settings.fps,
    H264_output: true,
  };
}
