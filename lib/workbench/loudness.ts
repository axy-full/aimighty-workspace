/*
 * Loudness of the cut's mix, as ITU-R BS.1770-4 measures it (integrated, in LUFS). Pure: no browser, no network, nothing
 * spent. The measuring runs on the mix the browser export would encode (lib/workbench/measure-loudness.ts), so a figure
 * here is the figure of the file that export makes.
 *
 * Two targets, chosen per deliverable (owner correction 9): Broadcast −23 LUFS and Web & social −14 LUFS. A cut is within
 * its target when it is within one LU of it.
 */

export type LoudnessTargetId = "broadcast" | "web";
export type LoudnessTarget = { id: LoudnessTargetId; lufs: number; label: string; short: string };
export const LOUDNESS_TARGETS: readonly LoudnessTarget[] = [
  { id: "broadcast", lufs: -23, label: "Broadcast −23 LUFS", short: "Broadcast" },
  { id: "web", lufs: -14, label: "Web & social −14 LUFS", short: "Web & social" },
];
export const DEFAULT_LOUDNESS_TARGET: LoudnessTargetId = "broadcast";
/** How far from the target, in LU, still counts as on target. */
export const LOUDNESS_TOLERANCE = 1;
export const targetOf = (id: string | null | undefined): LoudnessTarget => LOUDNESS_TARGETS.find((t) => t.id === id) ?? LOUDNESS_TARGETS[0];

/* BS.1770-4 K-weighting for 48 kHz: a high shelf, then a high pass (RLB). */
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [1, -1.69065929318241, 0.73248077421585] } as const;
const HIGHPASS = { b: [1, -2, 1], a: [1, -1.99004745483398, 0.99007225036621] } as const;
export const LOUDNESS_RATE = 48_000;

function biquad(input: Float32Array | Float64Array, c: { b: readonly number[]; a: readonly number[] }): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = c.b[0] * x + c.b[1] * x1 + c.b[2] * x2 - c.a[1] * y1 - c.a[2] * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

const kWeighted = (samples: Float32Array | Float64Array) => biquad(biquad(samples, SHELF), HIGHPASS);
const lufsOf = (energy: number) => -0.691 + 10 * Math.log10(energy);

/**
 * Integrated loudness of a stereo signal at 48 kHz: 400 ms blocks every 100 ms, an absolute gate at −70 LUFS, then a
 * relative gate 10 LU under the gated average. Null when nothing passes the gates (silence).
 */
export function integratedLoudness(left: Float32Array | Float64Array, right: Float32Array | Float64Array, sampleRate = LOUDNESS_RATE): number | null {
  if (sampleRate !== LOUDNESS_RATE) throw new Error("Loudness is measured on 48 kHz audio.");
  if (left.length !== right.length) throw new Error("Both channels must be the same length.");
  const block = Math.round(0.4 * sampleRate), hop = Math.round(0.1 * sampleRate);
  if (left.length < block) return null;
  const l = kWeighted(left), r = kWeighted(right);
  /* Running sums of squares make every block a subtraction. */
  const sums = new Float64Array(l.length + 1);
  for (let i = 0; i < l.length; i++) sums[i + 1] = sums[i] + l[i] * l[i] + r[i] * r[i];
  const energies: number[] = [];
  for (let start = 0; start + block <= l.length; start += hop) energies.push((sums[start + block] - sums[start]) / block);
  const audible = energies.filter((e) => e > 0 && lufsOf(e) > -70);
  if (!audible.length) return null;
  const relative = lufsOf(audible.reduce((n, e) => n + e, 0) / audible.length) - 10;
  const kept = audible.filter((e) => lufsOf(e) > relative);
  if (!kept.length) return null;
  return lufsOf(kept.reduce((n, e) => n + e, 0) / kept.length);
}

export type LoudnessVerdict = { kind: "ok" | "loud" | "quiet" | "silent"; /** LU above (+) or below (−) the target. */ diff: number };

export function loudnessVerdict(measured: number | null, target: LoudnessTarget): LoudnessVerdict {
  if (measured == null || !Number.isFinite(measured)) return { kind: "silent", diff: 0 };
  const diff = measured - target.lufs;
  return { kind: Math.abs(diff) <= LOUDNESS_TOLERANCE ? "ok" : diff > 0 ? "loud" : "quiet", diff };
}

/** "−23.0": one decimal, a real minus sign. */
export const lufsWords = (lufs: number) => `${lufs < 0 ? "−" : ""}${Math.abs(lufs).toFixed(1)}`;

/** What the check found, in words: "−19.6 LUFS · 3.4 LU too loud". */
export function verdictWords(measured: number | null, target: LoudnessTarget): string {
  const v = loudnessVerdict(measured, target);
  if (v.kind === "silent" || measured == null) return "Nothing to measure · the cut has no sound";
  const lufs = `${lufsWords(measured)} LUFS`;
  if (v.kind === "ok") return `${lufs} ✓`;
  return `${lufs} · ${Math.abs(v.diff).toFixed(1)} LU too ${v.kind === "loud" ? "loud" : "quiet"}`;
}

/** The change in dB that would bring the measured loudness to the target. */
export const gainToTarget = (measured: number, target: LoudnessTarget) => target.lufs - measured;
