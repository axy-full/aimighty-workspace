"use client";
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  type InputAudioTrack,
} from "mediabunny";
import {
  audibleClips,
  AUDIO_LIMIT_SECONDS,
  AUDIO_SAMPLE_RATE,
  validateAudio,
} from "./audio";
import { type Asset, type Project } from "./studio";
import { MOVIE_SOURCE_LIMIT } from "./movie";
export type AudioSource = { audio?: InputAudioTrack | null; origin?: number };
export async function mixAudio(
  p: Project,
  loaded: Map<string, AudioSource>,
  options: { clipAudio: boolean; soundtrack: boolean },
  signal: AbortSignal,
) {
  validateAudio(p);
  const duration = p.shots.reduce((n, s) => n + s.duration, 0) / p.fps;
  if (!duration || duration > AUDIO_LIMIT_SECONDS)
    throw new Error(
      "Sound preview and WAV delivery support edits up to 3 minutes.",
    );
  const overlappingSeconds =
    (options.soundtrack
      ? audibleClips(p).reduce((n, c) => n + c.duration / p.fps, 0)
      : 0) + (options.clipAudio ? duration : 0);
  if (overlappingSeconds > 720)
    throw new Error(
      "This device supports 12 minutes of combined audio sources within a 3-minute edit. Reduce overlapping clips.",
    );
  const context = new OfflineAudioContext(
    2,
    Math.round(duration * AUDIO_SAMPLE_RATE),
    AUDIO_SAMPLE_RATE,
  );
  let scheduled = 0;
  const schedule = async (
    id: string,
    start: number,
    length: number,
    offset: number,
    gainDb = 0,
    pan = 0,
    fadeIn = 0,
    fadeOut = 0,
    strict = false,
  ) => {
    const track = loaded.get(id)?.audio;
    if (!track) {
      if (strict) throw new Error("An audio clip has no decodable sound.");
      return;
    }
    const end = start + length;
    if (
      strict &&
      (offset + length > duration + 0.00001 ||
        end > (await track.computeDuration()) + 0.001)
    )
      throw new Error(
        "An audio clip extends past its source or the sequence. Shorten it in Sound mix.",
      );
    const gain = context.createGain(),
      panner = context.createStereoPanner(),
      level = 10 ** (gainDb / 20);
    panner.pan.value = pan;
    if (pan === 0) gain.connect(context.destination);
    else {
      gain.connect(panner);
      panner.connect(context.destination);
    }
    gain.gain.setValueAtTime(fadeIn ? 0 : level, offset);
    if (fadeIn) gain.gain.linearRampToValueAtTime(level, offset + fadeIn);
    if (fadeOut) {
      gain.gain.setValueAtTime(level, offset + length - fadeOut);
      gain.gain.linearRampToValueAtTime(0, offset + length);
    }
    for await (const { buffer, timestamp } of new AudioBufferSink(
      track,
    ).buffers(start, end)) {
      signal.throwIfAborted();
      const from = Math.max(start, timestamp),
        to = Math.min(end, timestamp + buffer.duration);
      if (to <= from) continue;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(gain);
      node.start(offset + from - start, from - timestamp, to - from);
      scheduled++;
    }
  };
  let at = 0;
  // Solo is a mixer audition: original production audio is muted while an isolated clip is soloed.
  const clips = audibleClips(p),
    solo = options.soundtrack && clips.some((c) => c.solo);
  if (options.clipAudio && !solo)
    for (const shot of p.shots) {
      await schedule(
        shot.assetId,
        (loaded.get(shot.assetId)?.origin ?? 0) + shot.sourceIn / p.fps,
        shot.duration / p.fps,
        at / p.fps,
      );
      at += shot.duration;
    }
  if (options.soundtrack)
    for (const clip of clips) {
      const track = loaded.get(clip.assetId)?.audio;
      const first = track ? Math.max(0, await track.getFirstTimestamp()) : 0;
      await schedule(
        clip.assetId,
        first + clip.sourceIn / p.fps,
        clip.duration / p.fps,
        clip.startFrame / p.fps,
        clip.gainDb,
        clip.pan,
        clip.fadeIn / p.fps,
        clip.fadeOut / p.fps,
        !(p.audioAssetId && clip.id === "legacy-soundtrack"),
      );
    }
  signal.throwIfAborted();
  if (!scheduled) return { buffer: undefined, gain: 1, peak: 0 };
  const buffer = await context.startRendering();
  signal.throwIfAborted();
  let peak = 0;
  for (let ch = 0; ch < 2; ch++)
    for (const value of buffer.getChannelData(ch))
      peak = Math.max(peak, Math.abs(value));
  const gain = peak > 1 ? 1 / peak : 1;
  if (gain < 1)
    for (let ch = 0; ch < 2; ch++) {
      const samples = buffer.getChannelData(ch);
      for (let i = 0; i < samples.length; i++) samples[i] *= gain;
    }
  return { buffer, gain, peak };
}
/** Read bounded, authenticated sources; never send private audio to an external renderer. */
export async function prepareAudioMix(p: Project, signal: AbortSignal) {
  validateAudio(p);
  const ids = new Set(audibleClips(p).map((c) => c.assetId));
  if (p.clipAudio !== false)
    for (const shot of p.shots)
      if (p.assets.find((a) => a.id === shot.assetId)?.kind === "video")
        ids.add(shot.assetId);
  let bytes = 0;
  const loaded = new Map<string, AudioSource>(),
    inputs: Input[] = [];
  const abort = () => inputs.forEach((i) => i.dispose());
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (const id of ids) {
      signal.throwIfAborted();
      const asset = p.assets.find((a) => a.id === id)!;
      const blob = await readAudioSource(asset, signal, (n) => {
        bytes += n;
        if (bytes > MOVIE_SOURCE_LIMIT)
          throw new Error("Sound mix supports up to 200 MB of source media.");
      });
      const input = new Input({
        source: new BlobSource(blob),
        formats: ALL_FORMATS,
      });
      inputs.push(input);
      const audio = await input.getPrimaryAudioTrack();
      if (audio && !(await audio.canDecode()))
        throw new Error(`Audio in ${asset.name} cannot be decoded here.`);
      if (asset.kind === "audio" && !audio)
        throw new Error(`${asset.name} has no audio track.`);
      const video =
        asset.kind === "video" ? await input.getPrimaryVideoTrack() : undefined;
      loaded.set(id, {
        audio,
        origin: video ? Math.max(0, await video.getFirstTimestamp()) : 0,
      });
    }
    return await mixAudio(
      p,
      loaded,
      { clipAudio: p.clipAudio !== false, soundtrack: true },
      signal,
    );
  } finally {
    signal.removeEventListener("abort", abort);
    inputs.forEach((i) => i.dispose());
  }
}
async function readAudioSource(
  asset: Asset,
  signal: AbortSignal,
  count: (n: number) => void,
) {
  const url = new URL(asset.url, window.location.href);
  if (url.origin !== window.location.origin)
    throw new Error(`Import ${asset.name} into this workspace before mixing.`);
  if (/^\/api\/media\/[^/]+$/.test(url.pathname))
    url.searchParams.set("stream", "1");
  const response = await fetch(url, { signal, credentials: "same-origin" });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The source for ${asset.name} is unavailable.`);
  }
  const reader = response.body.getReader(),
    parts: Uint8Array<ArrayBuffer>[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      signal.throwIfAborted();
      count(part.value.byteLength);
      parts.push(new Uint8Array(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const blob = new Blob(parts, {
    type: response.headers.get("content-type") || asset.mime,
  });
  if (!blob.size) throw new Error(`${asset.name} is empty.`);
  return blob;
}
