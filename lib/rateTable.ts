import type { TaskId } from "./tasks";

/**
 * The rates a browser is allowed to see — already in the unit that workspace
 * pays in, so nothing on the client ever converts and nothing has to know the
 * margin.
 *
 * This exists because the composer prices a duration change without a round
 * trip, which means the rates have to be in the bundle, which meant the
 * VENDOR's rates were in the bundle. With the margin table beside them —
 * also a literal — anyone could compute the platform's markup, and §2 of the
 * scope of work says margin is never shown.
 *
 * The fix is not to stop shipping rates; it is to ship the right ones. A
 * workspace on the platform's keys is handed credits per second, credits per
 * still; one on its own keys is handed dollars, because dollars are what it
 * actually pays its vendors and it is entitled to them. Same shape either
 * way, so the estimator does not care which it is holding — and `credits ×
 * 0.10 ÷ margin` gives nothing away when there is no dollar figure to divide.
 *
 * Built on the server by lib/rateTable.server.ts and carried in the session.
 */

export type Unit = "cr" | "usd";

export type TableTier = { resolutions: string[]; withoutVideo: number; withVideo: number };
export type TableSecond = { resolutions: string[]; withoutAudio: number; withAudio: number };

export type ModelRates = {
  tiers?: TableTier[];
  secondRates?: TableSecond[];
  taskRates?: Partial<Record<TaskId, number>>;
  imagePricing?: Record<string, number>;
  imageRefIn?: number;
};

/** Per million tokens, in the table's unit. */
export type TextRate = { input: number; output: number };

export type RateTable = {
  unit: Unit;
  /**
   * The prompt writer, per million tokens, by model id.
   *
   * Here for the same reason the engines are: three Atomik screens quote what
   * a draft will cost before it runs, and they did it by importing the LLM
   * price list AND the margin table into the browser — the same leak as the
   * video rates, one file over.
   */
  text: Record<string, TextRate>;
  /** Per model id. A model absent here cannot be priced on this client. */
  models: Record<string, ModelRates>;
  /** What one credit costs, for the top-up screen — the only place §2 allows dollars. */
  creditUsd: number;
};

export const EMPTY_TABLE: RateTable = { unit: "cr", models: {}, text: {}, creditUsd: 0.1 };

/** The writer's frozen instruction is about this long; a finished prompt about this long. */
export const WRITER_SYSTEM_TOKENS = 1400;
export const WRITER_OUT_TOKENS = 220;

/**
 * What one writer call costs, in the table's unit — the same arithmetic
 * `estimateRefineUsd` does on the server, over rates already converted.
 */
export function writerCall(
  table: RateTable, model: string, promptChars: number, styleChars = 0,
): number | null {
  const rate = table.text[model] ?? table.text[model.replace(/^anthropic\//, "")];
  if (!rate) return null;
  const inTokens = WRITER_SYSTEM_TOKENS + Math.ceil(styleChars / 4) + Math.ceil(promptChars / 4);
  return (inTokens * rate.input + WRITER_OUT_TOKENS * rate.output) / 1e6;
}

/* ── The estimator, table-driven ─────────────────────────────────────────
   The same arithmetic the server has always used, with the numbers coming
   from the table rather than from the vendor. It is linear in the rate, which
   is the whole reason this works: swap dollars for credits in the table and
   every figure downstream is in credits, with no second implementation to
   drift from the first. */

/** Per-second engines: the rate times the seconds, and nothing to guess. */
export function secondRateOf(
  table: RateTable, modelId: string, resolution: string,
  opts: { audio?: boolean; task?: TaskId | string; fps60?: boolean } = {},
): number | null {
  const m = table.models[modelId];
  if (!m?.secondRates?.length) return null;
  const tier = m.secondRates.find((t) => t.resolutions.includes(resolution.toLowerCase())) ?? m.secondRates[0];
  const taskRate = opts.task && opts.task !== "generate" ? m.taskRates?.[opts.task as TaskId] : undefined;
  const base = taskRate ?? (opts.audio ? tier.withAudio : tier.withoutAudio);
  return base * (opts.fps60 ? 2 : 1);
}

export function listRateOf(
  table: RateTable, modelId: string, resolution: string, hasVideoInput = false,
): number | null {
  const tier = table.models[modelId]?.tiers?.find((t) => t.resolutions.includes(resolution.toLowerCase()));
  if (!tier) return null;
  return hasVideoInput ? tier.withVideo : tier.withoutVideo;
}

/**
 * What a video costs, in the table's unit.
 *
 * `tokens` and `costOf` are passed in rather than imported: how many frame
 * tokens a clip comes to is a fact about the codec, not about money, and it
 * stays in lib/models.ts where the browser may have it.
 */
export function estimateVideo(
  table: RateTable, modelId: string, resolution: string, duration: number,
  tokens: number | null,
  costOf: (tokens: number, rate: number) => number,
  opts: { audio?: boolean; task?: TaskId | string; fps60?: boolean; hasVideoInput?: boolean } = {},
): number | null {
  const perSecond = secondRateOf(table, modelId, resolution, opts);
  if (perSecond != null) {
    if (!(duration > 0)) return null;
    /* Rounded the way the server rounds it, at the same point: four places of
       whatever unit this is. In dollars that is hundredths of a cent; in
       credits it is a ten-thousandth of a credit, and either way what follows
       rounds up to whole credits. Kept identical so the two paths cannot
       disagree by a rounding step. */
    return Math.round(perSecond * duration * 10_000) / 10_000;
  }
  const list = listRateOf(table, modelId, resolution, opts.hasVideoInput ?? false);
  if (tokens == null || list == null) return null;
  return costOf(tokens, list);
}

export function estimateImage(
  table: RateTable, modelId: string, size: string, refImages = 0,
): number | null {
  const m = table.models[modelId];
  const prices = m?.imagePricing;
  if (!prices) return null;
  const out = prices[size.toUpperCase()] ?? prices[size];
  if (out == null) return null;
  return out + refImages * (m.imageRefIn ?? 0);
}

/**
 * Whole units, rounded up, at least one — the rule the metering layer bills
 * by, applied to a figure that is already in the workspace's unit.
 *
 * Dollars are not rounded this way, so a table in dollars returns the figure
 * untouched: a workspace on its own keys is quoted what its vendor charges,
 * to the cent, because that is what leaves its account.
 */
export function charged(table: RateTable, amount: number | null): number | null {
  if (amount == null) return null;
  if (table.unit === "usd") return amount;
  if (!(amount > 0)) return 0;
  return Math.max(1, Math.ceil(amount - 1e-9));
}

/**
 * What a workspace has left once this press is billed — the `· 31 LEFT AFTER`
 * on the Render primary (design/particl-sow README, board 12i). Whole credits,
 * never below zero: a press the balance cannot cover reads `0 LEFT AFTER`, and
 * the server is what refuses it. `null` when the press has no price.
 */
export function leftAfter(balance: number, chargedAmount: number | null): number | null {
  if (chargedAmount == null || !Number.isFinite(balance)) return null;
  return Math.max(0, Math.floor(balance - chargedAmount + 1e-9));
}
