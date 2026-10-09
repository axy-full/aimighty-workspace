/**
 * Typical render times, measured (redesign plan, decision 8).
 *
 * How long a finished take of one engine usually took, as the middle half of
 * its recent history: the 25th to the 75th percentile of `duration_ms`, the
 * wall-clock time from asking to delivery (lib/jobs.ts writes it once, when a
 * take settles). An engine with fewer than MIN_TYPICAL_SAMPLES finished takes
 * falls back to lib/v12/typicalTimeDefaults.ts.
 *
 * Pure: the server measures with it (typicalTimes.server.ts), GET
 * /api/v12/typical-times answers with its `TypicalTimesReply`, and the
 * browser resolves one take's range from that reply with `typicalFor`. The
 * reply carries durations and nothing else — no workspace, count or cost.
 */
import { MIN_TYPICAL_SAMPLES, defaultTypical, type TypicalBounds } from "./typicalTimeDefaults";

export type TypicalSource = "history" | "default";
export type TypicalRange = TypicalBounds & { source: TypicalSource };
/** GET /api/v12/typical-times. `models`: per engine id, the engines with enough history. */
export type TypicalTimesReply = { models: Record<string, TypicalRange> };

/** The q-th quantile (0–1) of an ascending list, linearly interpolated. */
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const at = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** The middle half of a set of durations (ms), rounded to the second; null below the sample floor. */
export function rangeFromSamples(samples: readonly number[], min = MIN_TYPICAL_SAMPLES): TypicalBounds | null {
  const ms = samples.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (ms.length < min) return null;
  const round = (v: number) => Math.max(1_000, Math.round(v / 1_000) * 1_000);
  const lowMs = round(quantile(ms, 0.25));
  return { lowMs, highMs: Math.max(lowMs, round(quantile(ms, 0.75))) };
}

/**
 * Per engine, the first source with enough samples: the platform's history
 * first (so a small workspace still gets a figure), then the workspace's own.
 * An engine neither has enough of is left out; `typicalFor` then falls back.
 */
export function typicalTable(
  platform: ReadonlyMap<string, readonly number[]>,
  workspace: ReadonlyMap<string, readonly number[]> = new Map(),
): Record<string, TypicalRange> {
  const out: Record<string, TypicalRange> = {};
  for (const model of new Set([...platform.keys(), ...workspace.keys()])) {
    const range = rangeFromSamples(platform.get(model) ?? []) ?? rangeFromSamples(workspace.get(model) ?? []);
    if (range) out[model] = { ...range, source: "history" };
  }
  return out;
}

/** Group (model, duration) rows by model. */
export function samplesByModel(rows: readonly { model: string; ms: number }[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.model || !Number.isFinite(r.ms) || r.ms <= 0) continue;
    const list = out.get(r.model);
    if (list) list.push(r.ms);
    else out.set(r.model, [r.ms]);
  }
  return out;
}

/** The reply, checked: a row that is not two sane durations is dropped. */
export function parseTypicalTimes(value: unknown): TypicalTimesReply {
  const models: Record<string, TypicalRange> = {};
  const raw = value && typeof value === "object" ? (value as { models?: unknown }).models : null;
  if (raw && typeof raw === "object") {
    for (const [id, r] of Object.entries(raw as Record<string, unknown>)) {
      const { lowMs, highMs } = (r ?? {}) as Partial<TypicalRange>;
      if (typeof lowMs === "number" && typeof highMs === "number" && lowMs > 0 && highMs >= lowMs && highMs < 24 * 3_600_000)
        models[id] = { lowMs, highMs, source: "history" };
    }
  }
  return { models };
}

/** One take's typical range: measured when its engine has history, else the config's fallback. */
export function typicalFor(model: string | null | undefined, kind: string | null | undefined, reply?: TypicalTimesReply | null): TypicalRange {
  const measured = model && reply?.models && Object.hasOwn(reply.models, model) ? reply.models[model] : null;
  if (measured) return { lowMs: measured.lowMs, highMs: measured.highMs, source: "history" };
  return { ...defaultTypical(model, kind), source: "default" };
}

/* ── Words ───────────────────────────────────────────────────────────── */

const secondsOf = (ms: number) => Math.max(5, Math.round(ms / 5_000) * 5);
const minutesOf = (ms: number, up: boolean) => Math.max(1, up ? Math.ceil(ms / 60_000 - 0.15) : Math.round(ms / 60_000));

/**
 * A range the way a person says it: "2–4 min", "20–40 s", "40 s–2 min", and
 * "about 15 s" when both ends say the same. Seconds round to 5; minutes round
 * the low end and lift the high end, so the range is never narrower than
 * what was measured by more than a few seconds.
 */
export function fmtTypical(range: TypicalBounds): string {
  const { lowMs, highMs } = range;
  if (highMs < 60_000) {
    const lo = secondsOf(lowMs), hi = secondsOf(highMs);
    return lo === hi ? `about ${lo} s` : `${lo}–${hi} s`;
  }
  const hi = minutesOf(highMs, true);
  if (lowMs < 60_000 - 2_500) return `${secondsOf(lowMs)} s–${hi} min`;
  const lo = Math.min(minutesOf(lowMs, false), hi);
  return lo === hi ? `about ${lo} min` : `${lo}–${hi} min`;
}
