import { test, expect } from "@playwright/test";
import { DUCK_RAMP_SECONDS, duckGain, voiceWindows, toTimeline, validateProps } from "../../remotion/src/lib";
import { checkSpec, contradictions, declaredOf, inputFilesOf } from "../../remotion/node/export";
import type { MediaFacts, Prober } from "../../remotion/node/probe";

/* Narrated assembly: voice lines laid over a `final`, the music and the clips' own sound ducked while one plays. */

const SOURCE = { file: "a.mp4", durationSeconds: 10, width: 1920, height: 1080, hasAudio: true };
const clip = { source: SOURCE, trim: { startSeconds: 0, endSeconds: 6 }, cues: [], reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } };
const base = { aspect: "16:9", scale: 0.25, title: null, clips: [clip], captionStyle: null, end: null, music: { file: "bed.mp3", durationSeconds: 8, volume: 0.5 } };
const line = (over: Record<string, unknown> = {}) => ({ file: "vo1.mp3", durationSeconds: 2, startSeconds: 1, volume: 1, ...over });
const props = (extra: Record<string, unknown> = {}) => ({ ...base, ...extra });

test("windows: where voice plays, sorted, with overlapping or touching lines merged", () => {
  const t = (lines: [number, number][]) => ({ voiceover: lines.map(([from, durationInFrames]) => ({ file: "x.mp3", from, durationInFrames, volume: 1 })) });
  expect(voiceWindows(t([[60, 30], [0, 30]]))).toEqual([{ from: 0, to: 30 }, { from: 60, to: 90 }]);
  expect(voiceWindows(t([[0, 30], [30, 30], [50, 20]]))).toEqual([{ from: 0, to: 70 }]);
  expect(voiceWindows(t([]))).toEqual([]);
});

test("the gain is 1 away from the voice, the duck inside it, and a straight ramp of 0.2 s on each side", () => {
  const fps = 30;
  const windows = [{ from: 60, to: 90 }];
  const ramp = Math.round(DUCK_RAMP_SECONDS * fps);
  expect(ramp).toBe(6);
  expect(duckGain(0, windows, 0.3, fps)).toBe(1);
  expect(duckGain(60 - ramp, windows, 0.3, fps)).toBe(1);
  expect(duckGain(60 - 3, windows, 0.3, fps)).toBeCloseTo(0.3 + 0.7 * 0.5, 10);
  expect(duckGain(59, windows, 0.3, fps)).toBeLessThan(0.45);
  for (const frame of [60, 75, 89]) expect(duckGain(frame, windows, 0.3, fps)).toBe(0.3);
  expect(duckGain(90, windows, 0.3, fps)).toBeCloseTo(0.3 + 0.7 * (1 / 6), 10);
  expect(duckGain(90 + ramp - 2, windows, 0.3, fps)).toBeLessThan(1);
  expect(duckGain(90 + ramp - 1, windows, 0.3, fps)).toBe(1);
  /* The ramp is as long after the voice as before it. */
  expect(duckGain(60 - ramp + 1, windows, 0.3, fps)).toBeCloseTo(duckGain(90 + ramp - 2, windows, 0.3, fps), 10);
  /* It only ever goes down and comes back: monotone on each side. */
  const before = Array.from({ length: 8 }, (_, i) => duckGain(54 + i, windows, 0.3, fps));
  expect([...before]).toEqual([...before].sort((a, b) => b - a));
});

test("no ducking when the share is 1, when there is no voice, and the nearest of several windows decides", () => {
  expect(duckGain(70, [{ from: 60, to: 90 }], 1, 30)).toBe(1);
  expect(duckGain(70, [], 0.3, 30)).toBe(1);
  expect(duckGain(100, [{ from: 60, to: 90 }, { from: 100, to: 120 }], 0.2, 30)).toBe(0.2);
});

test("the props: voice lines and a duck share are optional, default to none and 0.3, and are checked", () => {
  const ok = validateProps("final", props());
  expect(ok).toMatchObject({ ok: true, value: { voiceover: [], duck: 0.3 } });
  const withVoice = validateProps("final", props({ voiceover: [line(), line({ file: "vo2.wav", startSeconds: 4, volume: 0.8 })], duck: 0.5 }));
  expect(withVoice).toMatchObject({ ok: true, value: { duck: 0.5, voiceover: [{ file: "vo1.mp3", startSeconds: 1, volume: 1 }, { file: "vo2.wav", startSeconds: 4, volume: 0.8 }] } });
  expect(validateProps("final", props({ voiceover: [{ file: "vo.mp3", durationSeconds: 2 }] }))).toMatchObject({ ok: true, value: { voiceover: [{ startSeconds: 0, volume: 1 }] } });
  const errors = (extra: Record<string, unknown>) => { const r = validateProps("final", props(extra)); return r.ok ? [] : r.errors; };
  expect(errors({ voiceover: [line({ file: "../x.mp3" })] }).join()).toMatch(/voiceover\[0\]\.file/);
  expect(errors({ voiceover: [line({ file: "https://x.test/a.mp3" })] }).join()).toMatch(/voiceover\[0\]\.file/);
  expect(errors({ voiceover: [line({ file: "clip.mp4" })] }).join()).toMatch(/voiceover\[0\]\.file/);
  expect(errors({ voiceover: [line({ durationSeconds: 0 })] }).join()).toMatch(/voiceover\[0\]\.durationSeconds/);
  expect(errors({ voiceover: [line({ startSeconds: -1 })] }).join()).toMatch(/voiceover\[0\]\.startSeconds/);
  expect(errors({ voiceover: [line({ volume: 2 })] }).join()).toMatch(/voiceover\[0\]\.volume/);
  expect(errors({ voiceover: [line({ extra: 1 })] }).join()).toMatch(/voiceover\[0\]\.extra/);
  expect(errors({ voiceover: Array.from({ length: 25 }, () => line()) }).join()).toMatch(/at most 24 voice lines/);
  expect(errors({ voiceover: "vo.mp3" }).join()).toMatch(/props\.voiceover/);
  expect(errors({ duck: 1.5 }).join()).toMatch(/props\.duck/);
  expect(errors({ duck: -0.1 }).join()).toMatch(/props\.duck/);
});

test("the timeline: lines in frames, clipped to the end of the cut; a line that starts after the end is refused", () => {
  const checked = validateProps("final", props({ voiceover: [line({ startSeconds: 1, durationSeconds: 2 }), line({ file: "vo2.mp3", startSeconds: 5, durationSeconds: 4 })], duck: 0.4 }));
  if (!checked.ok) throw new Error(checked.errors.join());
  const t = toTimeline("final", checked.value);
  expect(t.durationInFrames).toBe(180);
  expect(t.duck).toBe(0.4);
  expect(t.voiceover).toEqual([{ file: "vo1.mp3", from: 30, durationInFrames: 60, volume: 1 }, { file: "vo2.mp3", from: 150, durationInFrames: 30, volume: 1 }]);
  const late = validateProps("final", props({ voiceover: [line({ startSeconds: 6 })] }));
  if (!late.ok) throw new Error(late.errors.join());
  expect(() => toTimeline("final", late.value)).toThrow(/voiceover\[0\]: starts at 6 s, after the end of the cut \(6\.0 s\)/);
  expect(checkSpec({ version: 1, composition: "final", props: props({ voiceover: [line({ startSeconds: 6 })] }) })).toMatchObject({ ok: false, code: "spec_invalid" });
  const plain = validateProps("final", props());
  if (!plain.ok) throw new Error(plain.errors.join());
  const none = toTimeline("final", plain.value);
  expect(none.voiceover).toEqual([]);
  expect(none.duck).toBe(0.3);
});

test("the voice files are inputs like the music: they must exist, have sound and be as long as the request says", async () => {
  const checked = checkSpec({ version: 1, composition: "final", props: props({ voiceover: [line(), line({ file: "vo2.mp3", startSeconds: 4, durationSeconds: 1.5 })] }) });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  expect(inputFilesOf(checked.timeline).sort()).toEqual(["a.mp4", "bed.mp3", "vo1.mp3", "vo2.mp3"]);
  const declared = declaredOf(checked.id, checked.props);
  expect(declared.filter((d) => d.kind === "audio").map((d) => [d.file, d.durationSeconds]).sort()).toEqual([["bed.mp3", 8], ["vo1.mp3", 2], ["vo2.mp3", 1.5]]);
  const facts = (over: Partial<MediaFacts> = {}): MediaFacts => ({ durationSeconds: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: true, ...over });
  const prober: Prober = { probe: async (file) => (file.endsWith("vo1.mp3") ? facts({ hasVideo: false, durationSeconds: 3.5 }) : file.endsWith("vo2.mp3") ? facts({ hasVideo: false, hasAudio: false, durationSeconds: 1.5 }) : file.endsWith("bed.mp3") ? facts({ hasVideo: false, durationSeconds: 8 }) : facts()) };
  const reasons = await contradictions(declared, "/in", prober);
  expect(reasons).toEqual(expect.arrayContaining(["input/vo1.mp3: is 3.50 s, the request says 2 s", "input/vo2.mp3: has no audio"]));
  expect(reasons).toHaveLength(2);
});
