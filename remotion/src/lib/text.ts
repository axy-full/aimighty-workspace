/**
 * A font size that makes `text` fit `lines` lines of `widthPx`, between `minPx` and `maxPx`.
 * Letter width is a fixed share of the em (0.56 for a geometric sans in capitals-and-lowercase),
 * which is close enough to size a card: CSS wraps the text and the size only has to be sane.
 */
export function fitFontSize(input: { text: string; widthPx: number; maxPx: number; minPx: number; lines: number; letterEm?: number }): number {
  const { text, widthPx, maxPx, minPx, lines } = input;
  const em = input.letterEm ?? 0.56;
  const length = Math.max(1, text.length);
  // Wrapping wastes about a word's width per line; add half a line of slack.
  const needed = length / Math.max(1, lines - 0.5);
  const size = widthPx / (needed * em);
  return Math.round(Math.max(minPx, Math.min(maxPx, size)));
}

/** Letters per caption page by shape: a tall frame has narrower lines. */
export const CAPTION_CHARS = { "16:9": 34, "9:16": 20 } as const;
