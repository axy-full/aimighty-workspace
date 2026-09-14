import { validateSequence, type Project } from "./studio";

export const MOVIE_LIMIT_SECONDS = 180;
export const MOVIE_SOURCE_LIMIT = 200 * 1024 * 1024;
export type MovieFormat = "mp4" | "webm";
export type MovieOptions = {
  format: MovieFormat;
  resolution: 720 | 1080;
  fit: "contain" | "cover";
  clipAudio: boolean;
  soundtrack: boolean;
};
export const defaultMovieOptions: MovieOptions = {
  format: "mp4",
  resolution: 720,
  fit: "contain",
  clipAudio: true,
  soundtrack: true,
};
export function movieDimensions(aspect: string, resolution: number) {
  const ratios: Record<string, [number, number]> = {
    "16:9": [16, 9],
    "9:16": [9, 16],
    "1:1": [1, 1],
    "4:5": [4, 5],
  };
  const ratio = ratios[aspect];
  if (!ratio || ![720, 1080].includes(resolution))
    throw new Error(
      "Choose a supported delivery aspect and 720p or 1080p resolution.",
    );
  const scale = resolution / Math.min(...ratio);
  return {
    width: Math.round((ratio[0] * scale) / 2) * 2,
    height: Math.round((ratio[1] * scale) / 2) * 2,
  };
}
export function moviePlan(project: Project, options: MovieOptions) {
  validateSequence(project);
  const dimensions = movieDimensions(project.aspect, options.resolution);
  const totalFrames = project.shots.reduce(
    (sum, shot) => sum + shot.duration,
    0,
  );
  if (totalFrames / project.fps > MOVIE_LIMIT_SECONDS)
    throw new Error(
      "Movie export supports edits up to 3 minutes. Export a shorter sequence or use the editorial package.",
    );
  let frame = 0;
  const clips = project.shots.map((shot) => {
    const clip = {
      ...shot,
      startFrame: frame,
      asset: project.assets.find((asset) => asset.id === shot.assetId)!,
    };
    frame += shot.duration;
    return clip;
  });
  return {
    ...dimensions,
    totalFrames,
    duration: totalFrames / project.fps,
    clips,
  };
}
export function fittedRect(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  fit: MovieOptions["fit"],
) {
  const scale = (fit === "cover" ? Math.max : Math.min)(
    width / sourceWidth,
    height / sourceHeight,
  );
  const drawnWidth = sourceWidth * scale,
    drawnHeight = sourceHeight * scale;
  return {
    x: (width - drawnWidth) / 2,
    y: (height - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  };
}
