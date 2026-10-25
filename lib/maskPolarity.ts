import { z } from "zod";

/**
 * One selection mask, and what each masked image-edit engine is sent (SOW v2 §7, §10 and Part II.12).
 *
 * The edit overlay makes one mask per selection: a coverage per pixel, 1 where the person selected, 0 where they
 * did not, and in between on a feathered edge. Engines disagree on which part of a mask they edit, so each engine
 * family's adapter converts this one mask to its own picture here, and nowhere else:
 * - black: the engine edits where the mask is black;
 * - white: the engine edits where the mask is white;
 * - transparent: the engine edits where the mask is transparent (alpha 0).
 * A feathered edge stays a ramp between the two, so the engine blends it.
 *
 * No masked image-edit adapter exists yet. These are pure functions; each adapter calls its family's when it lands.
 */

/** Rows first, left to right: coverage[y * width + x]. */
export type SelectionMask = { width: number; height: number; coverage: Float32Array };

/** The mask an engine is sent, as RGBA bytes, before the adapter encodes it. */
export type EngineMask = { width: number; height: number; rgba: Uint8ClampedArray };

/** Which part of its mask an engine edits. */
export type MaskPolarity = "black" | "white" | "transparent";

/** The engine families that take a mask, by the job they do. */
export type MaskFamily = "words" | "fill" | "eraser" | "removal" | "composite";

export const POLARITY: Record<MaskFamily, MaskPolarity> = {
  words: "black",
  fill: "white",
  eraser: "white",
  removal: "white",
  composite: "transparent",
};

/* The largest side any engine is sent; a bigger selection is a fault upstream, not a mask to convert. */
const MAX_SIDE = 16384;

export const selectionMaskSchema = z
  .object({
    width: z.number().int().min(1).max(MAX_SIDE),
    height: z.number().int().min(1).max(MAX_SIDE),
    coverage: z.instanceof(Float32Array),
  })
  .refine((m) => m.coverage.length === m.width * m.height, { message: "The coverage must hold one value per pixel." })
  .refine((m) => m.coverage.every((c) => c >= 0 && c <= 1), { message: "Every coverage is between 0 and 1." });

const byte = (unit: number) => Math.round(unit * 255);

/** The selection as one engine's mask. Refuses a mask that is not a whole, valid selection. */
export function engineMask(mask: SelectionMask, polarity: MaskPolarity): EngineMask {
  const { width, height, coverage } = selectionMaskSchema.parse(mask);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < coverage.length; i++) {
    const at = i * 4, selected = coverage[i];
    if (polarity === "transparent") {
      /* The colour is never read; only the alpha says what is edited. */
      rgba[at + 3] = byte(1 - selected);
      continue;
    }
    const grey = byte(polarity === "white" ? selected : 1 - selected);
    rgba[at] = rgba[at + 1] = rgba[at + 2] = grey;
    rgba[at + 3] = 255;
  }
  return { width, height, rgba };
}

/* One per family, for its adapter. */
export const wordsMask = (mask: SelectionMask) => engineMask(mask, POLARITY.words);
export const fillMask = (mask: SelectionMask) => engineMask(mask, POLARITY.fill);
export const eraserMask = (mask: SelectionMask) => engineMask(mask, POLARITY.eraser);
export const removalMask = (mask: SelectionMask) => engineMask(mask, POLARITY.removal);
export const compositeMask = (mask: SelectionMask) => engineMask(mask, POLARITY.composite);
