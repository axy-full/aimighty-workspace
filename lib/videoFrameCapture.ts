"use client";

export type VideoFrameSource = { id: string; origin: "upload" | "generation"; url: string; name: string };
export type VideoFrameEdge = "start" | "end";
export const VIDEO_FRAME_LIMITS = { bytes: 100 * 1024 * 1024, seconds: 300, pixels: 33_177_600, dimension: 8192, pngBytes: 32 * 1024 * 1024, timeoutMs: 45_000 } as const;

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Frame extraction was cancelled or timed out.");
}
function mediaEvent(video: HTMLVideoElement, event: "loadeddata" | "seeked", start: () => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => { video.removeEventListener(event, done); video.removeEventListener("error", fail); signal.removeEventListener("abort", fail); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error(signal.aborted ? "Frame extraction was cancelled or timed out." : "This browser cannot decode this original video. Try a compatible MP4, MOV or WebM.")); };
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
    else { try { start(); } catch { fail(); } }
  });
}

/** Decode only after an explicit click. Scope is checked by the authenticated
 * same-origin media route; bounded bytes become a temporary local object URL.
 * No CDN redirect, external URL, provider call or upload is made here. */
export async function captureVideoFrame(source: VideoFrameSource, edge: VideoFrameEdge, scope: string, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number; timeSeconds: number; durationSeconds: number; filename: string }> {
  if (!scope || !/^[A-Za-z0-9_-]{1,160}$/.test(source.id) || !["upload", "generation"].includes(source.origin) || !["start", "end"].includes(edge)) throw new Error("Choose an original video in the intended workspace first.");
  const canonical = `/api/${source.origin === "upload" ? "uploads" : "media"}/${source.id}`;
  if (source.url !== canonical && source.url !== `${canonical}?stream=1`) throw new Error("Frame extraction requires this video's authenticated original URL.");
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, VIDEO_FRAME_LIMITS.timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const active = controller.signal;
  const video = document.createElement("video"), canvas = document.createElement("canvas");
  let objectUrl: string | undefined;
  try {
    cancelled(active);
    const response = await fetch(source.origin === "generation" ? `${canonical}?stream=1` : canonical, { headers: { "X-Workbench-Scope": scope }, cache: "no-store", credentials: "same-origin", redirect: "error", signal: active });
    if (!response.ok || !response.body) throw new Error("This original is unavailable in the current workspace. Refresh its library entry.");
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!mime || !["video/mp4", "video/quicktime", "video/webm"].includes(mime) || Number(response.headers.get("content-length")) > VIDEO_FRAME_LIMITS.bytes) {
      await response.body.cancel();
      throw new Error("Choose an MP4, MOV or WebM original up to 100 MB.");
    }
    const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        cancelled(active);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > VIDEO_FRAME_LIMITS.bytes) throw new Error("Frame extraction accepts original videos up to 100 MB.");
        chunks.push(new Uint8Array(part.value));
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!bytes) throw new Error("The original video is empty.");
    objectUrl = URL.createObjectURL(new Blob(chunks, { type: mime }));
    video.muted = true; video.playsInline = true; video.preload = "auto";
    await mediaEvent(video, "loadeddata", () => { video.src = objectUrl!; video.load(); }, active);
    const width = video.videoWidth, height = video.videoHeight, durationSeconds = video.duration;
    if (![width, height, durationSeconds].every(value => Number.isFinite(value) && value > 0) || durationSeconds > VIDEO_FRAME_LIMITS.seconds || width > VIDEO_FRAME_LIMITS.dimension || height > VIDEO_FRAME_LIMITS.dimension || width * height > VIDEO_FRAME_LIMITS.pixels)
      throw new Error("Frame extraction needs a decodable video up to five minutes and 8K. The original will not be resized.");
    // Seek just inside the final sample rather than beyond the media endpoint.
    // At time zero loadeddata already exposes the first decoded picture.
    const timeSeconds = edge === "start" ? 0 : Math.max(0, durationSeconds - Math.min(0.001, durationSeconds / 2));
    if (timeSeconds !== video.currentTime) await mediaEvent(video, "seeked", () => { video.currentTime = timeSeconds; }, active);
    cancelled(active);
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot extract video frames.");
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const fail = () => { active.removeEventListener("abort", fail); reject(new Error("Frame extraction was cancelled or timed out.")); };
      active.addEventListener("abort", fail, { once: true });
      canvas.toBlob(value => { active.removeEventListener("abort", fail); if (active.aborted) fail(); else if (value) resolve(value); else reject(new Error("The frame could not be encoded as PNG.")); }, "image/png");
    });
    cancelled(active);
    if (blob.size > VIDEO_FRAME_LIMITS.pngBytes) throw new Error("This full-resolution PNG exceeds the 32 MB frame limit. The original was not resized.");
    const name = source.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().slice(0, 100) || "video";
    return { blob, width, height, timeSeconds, durationSeconds, filename: `${name}-${edge}-frame.png` };
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort();
    video.pause(); video.removeAttribute("src"); video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    canvas.width = 0; canvas.height = 0;
  }
}
