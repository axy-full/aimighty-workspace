"use client";

import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoCodec,
} from "mediabunny";
import { type Asset, type Project } from "./studio";
import { audioClips, audibleClips } from "./audio";
import { mixAudio } from "./mix-audio";
import { encodeMovieAac, prepareMovieAac } from "./movie-aac";
import {
  fittedRect,
  movieDimensions,
  moviePlan,
  MOVIE_SOURCE_LIMIT,
  type MovieFormat,
  type MovieOptions,
} from "./movie";

export type MovieCapability = {
  format: MovieFormat;
  videoCodec: VideoCodec;
  audioCodec: "aac" | "opus";
};
const sampleRate = 48000;
const outputLimit = 200 * 1024 * 1024;
export async function movieCapabilities(
  aspect: string,
  resolution: number,
): Promise<MovieCapability[]> {
  if (
    typeof VideoEncoder === "undefined" ||
    typeof VideoDecoder === "undefined"
  )
    return [];
  const size = movieDimensions(aspect, resolution);
  await prepareMovieAac();
  const [avc, aac, vp9, vp8, opus] = await Promise.all([
    canEncodeVideo("avc", size),
    canEncodeAudio("aac", { numberOfChannels: 2, sampleRate }),
    canEncodeVideo("vp9", size),
    canEncodeVideo("vp8", size),
    canEncodeAudio("opus", { numberOfChannels: 2, sampleRate }),
  ]);
  const result: MovieCapability[] = [];
  if (avc && aac)
    result.push({ format: "mp4", videoCodec: "avc", audioCodec: "aac" });
  if ((vp9 || vp8) && opus)
    result.push({
      format: "webm",
      videoCodec: vp9 ? "vp9" : "vp8",
      audioCodec: "opus",
    });
  return result;
}
type Loaded = {
  asset: Asset;
  input?: Input;
  image?: ImageBitmap;
  video?: InputVideoTrack;
  origin?: number;
  end?: number;
  audio?: InputAudioTrack | null;
};
export type MovieProgress = {
  phase: "Loading media" | "Mixing audio" | "Encoding video" | "Finalizing";
  fraction: number;
};

/** All media stays in this browser. Exact frame timestamps avoid real-time recording drift and dropped frames. */
export async function renderMovie(
  project: Project,
  options: MovieOptions,
  {
    signal,
    onProgress = () => {},
  }: { signal: AbortSignal; onProgress?: (progress: MovieProgress) => void },
) {
  const plan = moviePlan(project, options);
  const check = () => signal.throwIfAborted();
  check();
  const capability = (
    await movieCapabilities(project.aspect, options.resolution)
  ).find((item) => item.format === options.format);
  if (!capability)
    throw new Error(
      "This browser cannot encode the chosen format. Try WebM or a current desktop Chrome or Edge browser.",
    );
  const loaded = new Map<string, Loaded>();
  let output: Output | undefined;
  let sourceBytes = 0,
    encodedBytes = 0;
  const abort = () => {
    for (const source of loaded.values()) source.input?.dispose();
    if (output && output.state !== "finalized" && output.state !== "canceled")
      void output.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const needed = new Map(
      plan.clips.map((clip) => [clip.asset.id, clip.asset]),
    );
    if (options.soundtrack)
      for (const clip of audibleClips(project))
        needed.set(
          clip.assetId,
          project.assets.find((asset) => asset.id === clip.assetId)!,
        );
    for (const asset of needed.values()) {
      check();
      onProgress({
        phase: "Loading media",
        fraction: loaded.size / needed.size,
      });
      const url = new URL(asset.url, window.location.href);
      if (url.origin !== window.location.origin)
        throw new Error(
          `Import ${asset.name} into this workspace before rendering a movie.`,
        );
      if (/^\/api\/media\/[^/]+$/.test(url.pathname))
        url.searchParams.set("stream", "1");
      const response = await fetch(url, { signal, credentials: "same-origin" });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `The source for ${asset.name} is unavailable. Open or replace it before exporting.`,
        );
      }
      if (
        Number(response.headers.get("content-length")) >
        MOVIE_SOURCE_LIMIT - sourceBytes
      ) {
        await response.body.cancel().catch(() => {});
        throw new Error(
          "Movie export supports up to 200 MB of source media. Use a shorter edit or the editorial package.",
        );
      }
      const parts: Uint8Array<ArrayBuffer>[] = [];
      const reader = response.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          sourceBytes += part.value.byteLength;
          if (sourceBytes > MOVIE_SOURCE_LIMIT)
            throw new Error(
              "Movie export supports up to 200 MB of source media. Use a shorter edit or the editorial package.",
            );
          parts.push(new Uint8Array(part.value));
          check();
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const blob = new Blob(parts, {
        type: response.headers.get("content-type") || asset.mime,
      });
      if (!blob.size) throw new Error(`${asset.name} is empty.`);
      const source: Loaded = { asset };
      loaded.set(asset.id, source);
      if (asset.kind === "image") {
        source.image = await createImageBitmap(blob);
        if (source.image.width * source.image.height > 40_000_000)
          throw new Error(
            `${asset.name} exceeds the 40 megapixel image limit. Export a smaller still first.`,
          );
      } else {
        source.input = new Input({
          source: new BlobSource(blob),
          formats: ALL_FORMATS,
        });
        if (asset.kind === "video") {
          const video = await source.input.getPrimaryVideoTrack();
          if (!video || !(await video.canDecode()))
            throw new Error(
              `${asset.name} cannot be decoded here. Use H.264 MP4 or WebM source video.`,
            );
          source.video = video;
          source.origin = Math.max(0, await video.getFirstTimestamp());
          source.end = await video.computeDuration();
          if (video.displayWidth * video.displayHeight > 40_000_000)
            throw new Error(
              `${asset.name} exceeds the supported source dimensions.`,
            );
        }
        if (
          asset.kind === "audio" ||
          options.clipAudio ||
          (options.soundtrack &&
            audioClips(project).some((c) => c.assetId === asset.id))
        ) {
          source.audio = await source.input.getPrimaryAudioTrack();
          if (asset.kind === "audio" && !source.audio)
            throw new Error(`${asset.name} has no audio track.`);
          if (source.audio && !(await source.audio.canDecode()))
            throw new Error(
              `Audio in ${asset.name} cannot be decoded. Use WAV or a supported audio codec, or disable clip audio.`,
            );
        }
      }
    }
    for (const clip of plan.clips) {
      const source = loaded.get(clip.asset.id)!;
      if (
        source.video &&
        source.origin! + (clip.sourceIn + clip.duration) / project.fps >
          source.end! + 0.001
      )
        throw new Error(
          `${clip.name} runs past the end of ${clip.asset.name}. Shorten its duration or source in point.`,
        );
    }
    check();
    onProgress({ phase: "Mixing audio", fraction: 0 });
    const mix = await mixAudio(project, loaded, options, signal);
    let mixed = mix.buffer;
    const mixGain = mix.gain,
      hasAudio = Boolean(mixed);
    check();
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext("2d", {
      alpha: false,
      colorSpace: "srgb",
    });
    if (!context)
      throw new Error("Canvas rendering is unavailable in this browser.");
    const target = new BufferTarget();
    output = new Output({
      target,
      format:
        capability.format === "mp4"
          ? new Mp4OutputFormat({ fastStart: "in-memory" })
          : new WebMOutputFormat(),
    });
    const countBytes = (packet: { byteLength: number }) => {
      encodedBytes += packet.byteLength;
      if (encodedBytes > outputLimit)
        throw new Error(
          "The movie exceeds the 200 MB download limit. Use 720p or a shorter sequence.",
        );
    };
    const videoSource = new CanvasSource(canvas, {
      codec: capability.videoCodec,
      quality: new Quality({
        bitrate: options.resolution === 1080 ? 8_000_000 : 5_000_000,
      }),
      onEncodedPacket: countBytes,
    });
    output.addVideoTrack(videoSource, { frameRate: project.fps });
    const aacPackets =
      mixed && capability.audioCodec === "aac"
        ? await encodeMovieAac(mixed, signal)
        : undefined;
    const audioSource = aacPackets
      ? new EncodedAudioPacketSource("aac")
      : mixed
        ? new AudioBufferSource({
            codec: capability.audioCodec,
            quality: new Quality({ bitrate: 192_000 }),
            onEncodedPacket: countBytes,
          })
        : undefined;
    if (audioSource) output.addAudioTrack(audioSource);
    output.setMetadataTags({
      title: project.name,
      comment: "Particl timeline export; SDR canvas render; straight cuts.",
    });
    await output.start();
    if (audioSource && mixed) {
      if (audioSource instanceof EncodedAudioPacketSource && aacPackets) {
        for (const { packet, meta } of aacPackets) {
          check();
          countBytes(packet);
          await audioSource.add(packet, meta);
        }
      } else if (audioSource instanceof AudioBufferSource)
        await audioSource.add(mixed);
      audioSource.close();
      mixed = undefined;
    }
    for (const clip of plan.clips) {
      const source = loaded.get(clip.asset.id)!;
      const timestamps = function* () {
        for (let frame = 0; frame < clip.duration; frame++)
          yield source.origin! + (clip.sourceIn + frame) / project.fps;
      };
      const samples = source.video
        ? new VideoSampleSink(source.video).samplesAtTimestamps(timestamps())
        : undefined;
      try {
        for (let frame = 0; frame < clip.duration; frame++) {
          check();
          context.fillStyle = "black";
          context.fillRect(0, 0, plan.width, plan.height);
          if (samples) {
            const sample = (await samples.next()).value;
            if (!sample)
              throw new Error(
                `A frame in ${clip.asset.name} could not be decoded.`,
              );
            try {
              const rect = fittedRect(
                sample.displayWidth,
                sample.displayHeight,
                plan.width,
                plan.height,
                options.fit,
              );
              sample.draw(context, rect.x, rect.y, rect.width, rect.height);
            } finally {
              sample.close();
            }
          } else {
            const image = source.image!;
            const rect = fittedRect(
              image.width,
              image.height,
              plan.width,
              plan.height,
              options.fit,
            );
            context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
          }
          const timelineFrame = clip.startFrame + frame;
          await videoSource.add(timelineFrame / project.fps, 1 / project.fps, {
            keyFrame: frame === 0,
          });
          if (timelineFrame % project.fps === 0) {
            onProgress({
              phase: "Encoding video",
              fraction: timelineFrame / plan.totalFrames,
            });
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        }
      } finally {
        await samples?.return();
      }
    }
    videoSource.close();
    check();
    onProgress({ phase: "Finalizing", fraction: 1 });
    await output.finalize();
    check();
    if (!target.buffer || target.buffer.byteLength > outputLimit)
      throw new Error(
        "The movie could not be finalized within the 200 MB limit.",
      );
    return {
      blob: new Blob([target.buffer], {
        type: capability.format === "mp4" ? "video/mp4" : "video/webm",
      }),
      ...plan,
      format: capability.format,
      hasAudio,
      mixGain,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    for (const source of loaded.values()) {
      source.image?.close();
      source.input?.dispose();
    }
    if (output && output.state !== "finalized" && output.state !== "canceled")
      await output.cancel();
  }
}
