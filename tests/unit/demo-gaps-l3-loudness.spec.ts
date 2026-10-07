import { test, expect } from "@playwright/test";
import { LOUDNESS_RATE, LOUDNESS_TARGETS, gainToTarget, integratedLoudness, loudnessVerdict, lufsWords, targetOf, verdictWords } from "../../lib/workbench/loudness";

/*
 * Gap screens, lane 3 · Edit & Sound's loudness check. The measuring is ITU-R BS.1770-4: a 997 Hz tone at a known level reads
 * that level, silence reads nothing, a quiet stretch under the relative gate does not pull the figure down, and the two
 * targets (Broadcast −23, Web & social −14) are told apart in words a person reads.
 */
const seconds = (n: number) => Math.round(n * LOUDNESS_RATE);
function tone(dbfs: number, n: number, hz = 997): Float32Array {
  const a = 10 ** (dbfs / 20), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / LOUDNESS_RATE);
  return out;
}
const BROADCAST = targetOf("broadcast"), WEB = targetOf("web");

test("a stereo tone reads its own level, to a tenth of a unit", () => {
  const t = tone(-23, seconds(5));
  expect(integratedLoudness(t, t)).toBeCloseTo(-23, 1);
  const loud = tone(-14, seconds(5));
  expect(integratedLoudness(loud, loud)).toBeCloseTo(-14, 1);
});

test("one channel alone reads 3 LU under the same tone on both", () => {
  const t = tone(-20, seconds(4));
  const both = integratedLoudness(t, t)!;
  const one = integratedLoudness(t, new Float32Array(t.length))!;
  expect(both - one).toBeCloseTo(3.01, 1);
});

test("silence reads nothing; a clip shorter than one block reads nothing", () => {
  const z = new Float32Array(seconds(3));
  expect(integratedLoudness(z, z)).toBeNull();
  const short = tone(-20, seconds(0.2));
  expect(integratedLoudness(short, short)).toBeNull();
});

test("silence around a tone, and a very quiet tail, do not pull the figure down (the gates)", () => {
  const body = tone(-23, seconds(4)), quiet = tone(-70, seconds(4)), gap = new Float32Array(seconds(2));
  const join = (...parts: Float32Array[]) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
  const padded = join(gap, body, gap, quiet);
  expect(integratedLoudness(padded, padded)).toBeCloseTo(-23, 0);
});

test("the figure scales with gain: +6 dB reads 6 LU higher", () => {
  const a = tone(-26, seconds(4)), b = tone(-20, seconds(4));
  expect(integratedLoudness(b, b)! - integratedLoudness(a, a)!).toBeCloseTo(6, 1);
});

test("it measures 48 kHz only, and refuses two channels of different length", () => {
  const t = tone(-23, seconds(1));
  expect(() => integratedLoudness(t, t, 44_100)).toThrow(/48 kHz/);
  expect(() => integratedLoudness(t, t.subarray(0, 100))).toThrow(/same length/);
});

test("the two targets and their words", () => {
  expect(LOUDNESS_TARGETS.map((t) => t.label)).toEqual(["Broadcast −23 LUFS", "Web & social −14 LUFS"]);
  expect(targetOf(undefined).id).toBe("broadcast");
  expect(targetOf("nonsense").id).toBe("broadcast");
  expect(lufsWords(-19.64)).toBe("−19.6");
  expect(lufsWords(-23)).toBe("−23.0");
  expect(verdictWords(-23.2, BROADCAST)).toBe("−23.2 LUFS ✓");
  expect(verdictWords(-19.6, BROADCAST)).toBe("−19.6 LUFS · 3.4 LU too loud");
  expect(verdictWords(-19.6, WEB)).toBe("−19.6 LUFS · 5.6 LU too quiet");
  expect(verdictWords(-14.4, WEB)).toBe("−14.4 LUFS ✓");
  expect(verdictWords(null, WEB)).toBe("Nothing to measure · the cut has no sound");
});

test("the verdict is within one unit of the target; the gain to reach it", () => {
  expect(loudnessVerdict(-22.1, BROADCAST).kind).toBe("ok");
  expect(loudnessVerdict(-21.9, BROADCAST).kind).toBe("loud");
  expect(loudnessVerdict(-24.2, BROADCAST).kind).toBe("quiet");
  expect(loudnessVerdict(null, BROADCAST).kind).toBe("silent");
  expect(gainToTarget(-19.6, BROADCAST)).toBeCloseTo(-3.4, 5);
  expect(gainToTarget(-27, WEB)).toBeCloseTo(13, 5);
});
