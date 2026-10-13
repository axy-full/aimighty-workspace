import { execFile } from "node:child_process";

/** What the file says about itself. The declared values in a spec are checked against this, never trusted. */
export type MediaFacts = {
  durationSeconds: number;
  /** Picture size as shown (a 90 or 270 degree rotation tag swaps width and height). 0 for audio-only. */
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
};

export type Prober = { probe(absoluteFile: string): Promise<MediaFacts> };

type FfprobeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
};

export function factsFromFfprobe(json: { format?: { duration?: string }; streams?: FfprobeStream[] }): MediaFacts {
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && (s.width ?? 0) > 0);
  const audio = streams.find((s) => s.codec_type === "audio");
  const rotation = Math.abs(Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0)) % 360;
  const swap = rotation === 90 || rotation === 270;
  const duration = Number(json.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: swap ? (video?.height ?? 0) : (video?.width ?? 0),
    height: swap ? (video?.width ?? 0) : (video?.height ?? 0),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

export function createFfprobe(binary: string, timeoutMs = 30_000): Prober {
  return {
    probe(file) {
      return new Promise((resolve, reject) => {
        execFile(
          binary,
          ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", file],
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: {} as NodeJS.ProcessEnv },
          (error, stdout) => {
            if (error) return reject(new Error("could not be read as media"));
            try {
              resolve(factsFromFfprobe(JSON.parse(stdout)));
            } catch {
              reject(new Error("could not be read as media"));
            }
          },
        );
      });
    },
  };
}
