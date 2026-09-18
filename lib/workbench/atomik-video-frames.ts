"use client";
import type { Asset } from "./studio";
import { referenceAdFrameTimes } from "./reference-ad-analysis";
import { mediaReferenceIdentity } from "./media-reference-input";
import {
  ATOMIK_IMAGE_EDGE,
  atomikFrameTimes,
  type AtomikVideoFrame,
} from "./atomik-reference-types";

function mediaEvent(
  video: HTMLVideoElement,
  event: string,
  start: () => void,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, done);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", failed);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(
        new Error(
          signal.aborted
            ? "Video preparation was cancelled."
            : "This browser cannot decode the selected video. Upload a compatible MP4 review copy or select individual stills.",
        ),
      );
    };
    const timer = setTimeout(failed, 20_000);
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", failed, { once: true });
    if (signal.aborted) failed();
    else start();
  });
}

/** Browser decoding avoids a second paid call and keeps full video bytes out of
 * the model request. Only same-origin, authorized media endpoints are accepted. */
export async function sampleAtomikVideo(
  asset: Asset,
  signal: AbortSignal,
  referenceAd = false,
): Promise<{ blob: Blob; timeSeconds: number; durationSeconds?: number }[]> {
  const identity = referenceAd ? mediaReferenceIdentity(asset) : null;
  const sourceUrl = identity ? 'genId' in identity ? `/api/media/${identity.genId}` : `/api/uploads/${identity.uploadId}` : asset.url;
  if (!/^\/api\/(?:media|uploads|workbench\/media)\/[\w-]+$/.test(sourceUrl))
    throw new Error(
      "Upload " +
        asset.name +
        " into this workspace before using it as a video reference.",
    );
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const canvas = document.createElement("canvas");
  try {
    await mediaEvent(
      video,
      "loadeddata",
      () => {
        // Private generated media normally redirects to Blob's CDN. Canvas
        // extraction must keep the response on our authenticated origin.
        // Upload and legacy-upload handlers already return their bytes here.
        video.src = sourceUrl.startsWith("/api/media/")
          ? sourceUrl + "?stream=1"
          : sourceUrl;
        video.load();
      },
      signal,
    );
    const times = referenceAd ? referenceAdFrameTimes(video.duration) : atomikFrameTimes(video.duration);
    if (!video.videoWidth || !video.videoHeight)
      throw new Error("This video has no decodable picture track.");
    const scale = Math.min(
      1,
      ATOMIK_IMAGE_EDGE / Math.max(video.videoWidth, video.videoHeight),
    );
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot prepare video stills.");
    const frames = [];
    for (const timeSeconds of times) {
      await mediaEvent(
        video,
        "seeked",
        () => {
          video.currentTime = timeSeconds;
        },
        signal,
      );
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error("The sampled frame could not be encoded.")),
          "image/jpeg",
          0.85,
        ),
      );
      if (signal.aborted) throw new Error("Video preparation was cancelled.");
      frames.push({ blob, timeSeconds, ...(referenceAd ? { durationSeconds: video.duration } : {}) });
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function prepareAtomikVideoFrames(
  assets: Asset[],
  projectId: string,
  scope: string,
  signal: AbortSignal,
  referenceAd = false,
): Promise<AtomikVideoFrame[]> {
  const frames: AtomikVideoFrame[] = [];
  for (const asset of assets.filter((a) => a.kind === "video")) {
    const sampled = await sampleAtomikVideo(asset, signal, referenceAd);
    for (const frame of sampled) {
      if (signal.aborted) throw new Error("Video preparation was cancelled.");
      const response = await fetch(
        "/api/workbench/atomik/frames?" +
          new URLSearchParams({ projectId, assetId: asset.id }),
        {
          method: "POST",
          headers: { "Content-Type": "image/jpeg", "X-Workbench-Scope": scope },
          body: frame.blob,
          signal,
        },
      );
      const data = await response.json();
      if (!response.ok || typeof data.id !== "string")
        throw new Error(data.error || "A video still could not be saved.");
      frames.push({
        assetId: asset.id,
        uploadId: data.id,
        timeSeconds: frame.timeSeconds,
        ...(frame.durationSeconds === undefined ? {} : { durationSeconds: frame.durationSeconds }),
      });
    }
  }
  return frames;
}
