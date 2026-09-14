import type { Project } from "./studio";

export type AudioClip = {
  id: string;
  assetId: string;
  lane: "dialogue" | "music" | "sfx";
  startFrame: number;
  sourceIn: number;
  duration: number;
  gainDb: number;
  pan: number;
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
  solo: boolean;
};
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_LIMIT_SECONDS = 180;
/** Legacy soundtracks remain audible until the author migrates the edit. */
export function audioClips(p: Project): AudioClip[] {
  const clips = p.audioClips ?? [];
  if (!p.audioAssetId) return clips;
  return [
    {
      id: "legacy-soundtrack",
      assetId: p.audioAssetId,
      lane: "music",
      startFrame: 0,
      sourceIn: 0,
      duration: Math.max(1,p.shots.reduce((n, s) => n + s.duration, 0)),
      gainDb: 0,
      pan: 0,
      fadeIn: 0,
      fadeOut: 0,
      muted: false,
      solo: false,
    },
    ...clips,
  ];
}
export function validateAudio(p: Project) {
  const clips = audioClips(p),
    ids = new Set<string>();
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  for (const clip of clips) {
    if (ids.has(clip.id)) throw new Error("Two audio clips have the same ID.");
    ids.add(clip.id);
    if (!["audio", "video"].includes(assets.get(clip.assetId)?.kind ?? ""))
      throw new Error(
        "An audio source is missing. Restore its asset before saving or exporting.",
      );
    if (
      ![
        clip.startFrame,
        clip.sourceIn,
        clip.duration,
        clip.fadeIn,
        clip.fadeOut,
      ].every(Number.isSafeInteger) ||
      clip.startFrame < 0 ||
      clip.sourceIn < 0 ||
      clip.duration < 1 ||
      clip.fadeIn < 0 ||
      clip.fadeOut < 0 ||
      clip.fadeIn + clip.fadeOut > clip.duration
    )
      throw new Error(
        "Audio clips need valid frame positions and fades within their duration.",
      );
    if (
      !Number.isFinite(clip.gainDb) ||
      clip.gainDb < -60 ||
      clip.gainDb > 12 ||
      !Number.isFinite(clip.pan) ||
      Math.abs(clip.pan) > 1
    )
      throw new Error("Audio gain or pan is outside its supported range.");
  }
  if (clips.length > 64)
    throw new Error("An edit supports up to 64 audio clips.");
}
export function audibleClips(p: Project) {
  const clips = audioClips(p),
    solo = clips.some((c) => c.solo && !c.muted);
  return clips.filter((c) => !c.muted && (!solo || c.solo));
}
export function audioFingerprint(p: Project) {
  const ids = new Set([
    ...audioClips(p).map((c) => c.assetId),
    ...p.shots.map((s) => s.assetId),
  ]);
  return JSON.stringify([
    p.id,
    p.fps,
    p.shots,
    audioClips(p),
    p.clipAudio !== false,
    p.assets.filter((a) => ids.has(a.id)).map((a) => [a.id, a.url, a.version]),
  ]);
}
/** Interleaved stereo, little-endian PCM. Float WAV includes the required fact chunk. */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  format: "pcm24" | "float32",
) {
  if (
    channels.length !== 2 ||
    !channels[0].length ||
    channels[0].length !== channels[1].length ||
    sampleRate !== AUDIO_SAMPLE_RATE
  )
    throw new Error("WAV delivery requires stereo 48 kHz samples.");
  const count = channels[0].length,
    bytes = format === "pcm24" ? 3 : 4,
    header = format === "pcm24" ? 44 : 56;
  if (count > AUDIO_SAMPLE_RATE * AUDIO_LIMIT_SECONDS)
    throw new Error("Audio delivery supports up to 3 minutes on this device.");
  const buffer = new ArrayBuffer(header + count * 2 * bytes),
    view = new DataView(buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format === "pcm24" ? 1 : 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2 * bytes, true);
  view.setUint16(32, 2 * bytes, true);
  view.setUint16(34, bytes * 8, true);
  if (format === "float32") {
    text(36, "fact");
    view.setUint32(40, 4, true);
    view.setUint32(44, count, true);
  }
  text(header - 8, "data");
  view.setUint32(header - 4, count * 2 * bytes, true);
  let offset = header;
  for (let i = 0; i < count; i++)
    for (const channel of channels) {
      const value = channel[i];
      if (!Number.isFinite(value))
        throw new Error("The mix contains invalid audio samples.");
      if (format === "float32") view.setFloat32(offset, value, true);
      else {
        if (Math.abs(value) > 1)
          throw new Error(
            "The mix exceeds PCM headroom. Reduce its level before exporting.",
          );
        const n = Math.round(value * (value < 0 ? 8388608 : 8388607));
        view.setUint8(offset, n & 255);
        view.setUint8(offset + 1, (n >> 8) & 255);
        view.setUint8(offset + 2, (n >> 16) & 255);
      }
      offset += bytes;
    }
  return buffer;
}
