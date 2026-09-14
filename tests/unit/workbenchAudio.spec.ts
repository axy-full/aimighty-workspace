import { test, expect } from "@playwright/test";
import {
  audioClips,
  audibleClips,
  encodeWav,
  validateAudio,
  type AudioClip,
} from "../../lib/workbench/audio";
import { seedProject } from "../../lib/workbench/studio";
import { saveSchema } from "../../lib/workbench/studio-schema";
import { collectExportAssets } from "../../lib/workbench/studio-export";
const clip = (id = "one"): AudioClip => ({
  id,
  assetId: "sound",
  lane: "music",
  startFrame: 12,
  sourceIn: 6,
  duration: 24,
  gainDb: -6,
  pan: -1,
  fadeIn: 6,
  fadeOut: 6,
  muted: false,
  solo: false,
});
function project() {
  const p = seedProject();
  p.assets.push({
    ...p.assets[0],
    id: "sound",
    kind: "audio",
    mime: "audio/wav",
    url: "/api/uploads/sound",
    refs: ["environment"],
  });
  p.audioClips = [clip()];
  return p;
}
test("audio state survives schema parsing and editorial handoff includes audio source lineage", () => {
  const p = project();
  expect(
    saveSchema.parse({ project: p, revision: 2 }).project.audioClips,
  ).toEqual(p.audioClips);
  expect(collectExportAssets(p).map((a) => a.id)).toContain("sound");
  p.assets = p.assets.filter((a) => a.id !== "sound");
  expect(() => validateAudio(p)).toThrow(/missing/);
  expect(saveSchema.safeParse({ project: p, revision: 2 }).success).toBe(false);
});
test("mute wins over solo, and legacy soundtrack migration preserves its exact frame span", () => {
  const p = project();
  p.audioAssetId = "sound";
  const legacy = audioClips(p)[0];
  expect(legacy.duration).toBe(360);
  expect(legacy.id).toBe("legacy-soundtrack");
  p.audioClips = [
    clip(),
    { ...clip("solo"), solo: true },
    { ...clip("muted"), muted: true, solo: true },
  ];
  expect(audibleClips(p).map((c) => c.id)).toEqual(["solo"]);
  p.audioClips[1].muted = true;
  expect(audibleClips(p).map((c) => c.id)).toEqual([
    "legacy-soundtrack",
    "one",
  ]);
});
test("invalid fades, duplicate identities, nonfinite gain and missing sources cannot be saved", () => {
  for (const mutate of [
    (p: ReturnType<typeof project>) => {
      p.audioClips![0].fadeIn = 24;
    },
    (p: ReturnType<typeof project>) => {
      p.audioClips!.push(clip());
    },
    (p: ReturnType<typeof project>) => {
      p.audioClips![0].gainDb = NaN;
    },
    (p: ReturnType<typeof project>) => {
      p.audioClips![0].assetId = "missing";
    },
  ]) {
    const p = project();
    mutate(p);
    expect(saveSchema.safeParse({ project: p, revision: 0 }).success).toBe(
      false,
    );
  }
});
test("24-bit WAV retains signed samples and interleaving; float WAV carries a fact chunk and exact floats", () => {
  const channels = [
    Float32Array.from([-1, 0, 0.5, 1]),
    Float32Array.from([1, 0.5, 0, -1]),
  ];
  const pcm = new DataView(encodeWav(channels, 48000, "pcm24"));
  expect(pcm.getUint16(20, true)).toBe(1);
  expect(pcm.getUint16(34, true)).toBe(24);
  expect(pcm.getUint32(40, true)).toBe(24);
  expect([pcm.getUint8(44), pcm.getUint8(45), pcm.getUint8(46)]).toEqual([
    0, 0, 128,
  ]);
  expect([pcm.getUint8(47), pcm.getUint8(48), pcm.getUint8(49)]).toEqual([
    255, 255, 127,
  ]);
  const floats = encodeWav(channels, 48000, "float32"),
    view = new DataView(floats);
  expect(new TextDecoder().decode(floats.slice(36, 40))).toBe("fact");
  expect(view.getUint32(44, true)).toBe(4);
  expect(view.getFloat32(56, true)).toBe(-1);
  expect(view.getFloat32(60, true)).toBe(1);
  expect(() =>
    encodeWav([Float32Array.of(1.2), Float32Array.of(0)], 48000, "pcm24"),
  ).toThrow(/headroom/);
  expect(() =>
    encodeWav([Float32Array.of(NaN), Float32Array.of(0)], 48000, "float32"),
  ).toThrow(/invalid/);
});
