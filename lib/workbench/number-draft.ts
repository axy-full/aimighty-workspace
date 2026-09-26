/**
 * A number field someone is typing into. Clamping each keystroke turns "45"
 * into "105" (the "4" snaps to the minimum first) and a cleared field into a
 * default, so a typed value is only taken while it is already in range, and
 * it is settled — clamped, or put back — when the field is left.
 */
export type NumberBounds = { min: number; max: number; round?: boolean };

const parse = (text: string) => (text.trim() === "" ? NaN : Number(text));

/** The value to take while typing, or null while the text is partial or out of range. */
export function typedNumber(text: string, { min, max, round }: NumberBounds): number | null {
  const value = parse(text);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  return round ? Math.round(value) : value;
}

/** The value a field settles on when it is left: the text clamped into range, or the current value when it is not a number. */
export function settledNumber(text: string, current: number, { min, max, round }: NumberBounds): number {
  const value = parse(text);
  if (!Number.isFinite(value)) return current;
  const clamped = Math.max(min, Math.min(max, value));
  return round ? Math.max(min, Math.min(max, Math.round(clamped))) : clamped;
}

/**
 * A clip's new length and fades, from the fades it had when this edit of its
 * Duration began. Typing "25" commits "2" on the way; clamping from the
 * already-clamped fades would leave them at 2 once "25" arrives.
 */
export function retimedClip(start: { fadeIn: number; fadeOut: number }, duration: number) {
  return {
    duration,
    fadeIn: Math.min(start.fadeIn, duration),
    fadeOut: Math.min(start.fadeOut, Math.max(0, duration - start.fadeIn)),
  };
}
