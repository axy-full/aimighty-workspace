/**
 * What identity training and LoRA renders cost, on their own: lib/identities.ts
 * re-exports these, and a page that only quotes them (the public site's rate
 * card) imports this file instead of the whole identities module.
 */

/** Steps decide both quality and price. fal's default is 2500; 1500 is the
 *  point past which a face stops improving noticeably. */
export const TRAIN_STEPS = Math.max(500, Math.min(5000, Number(process.env.FAL_TRAIN_STEPS ?? 1500)));
/** fal's listed price for the portrait trainer (read 2026-09-03):
 *  "$0.0024 per step. A minimum of 1000 steps will be billed." */
export const TRAIN_USD_PER_STEP = Number(process.env.FAL_TRAIN_USD_PER_STEP ?? 0.0024);
export const TRAIN_MIN_BILLED_STEPS = 1000;

/** Rendering with a LoRA: "$0.035 per megapixel", rounded UP to the megapixel. */
export const RENDER_USD_PER_MP = Number(process.env.FAL_RENDER_USD_PER_MP ?? 0.035);

export const trainCostUsd = (steps = TRAIN_STEPS) =>
  Math.round(Math.max(steps, TRAIN_MIN_BILLED_STEPS) * TRAIN_USD_PER_STEP * 100) / 100;
