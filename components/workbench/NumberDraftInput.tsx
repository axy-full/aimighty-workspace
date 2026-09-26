"use client";
import { useId, useRef, useState, type InputHTMLAttributes } from "react";
import { settledNumber, typedNumber } from "@/lib/workbench/number-draft";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange" | "min" | "max"> & {
  value: number;
  min: number;
  max: number;
  /** Whole numbers only (frames). */
  round?: boolean;
  /**
   * `edit` names this focus of the field: every value committed while it
   * stays focused carries the same one, so a caller can treat the keystrokes
   * as one change (one undo step, one starting point).
   */
  onCommit: (value: number, edit: string) => void;
};

/**
 * A number input that lets its text be typed: an in-range value is taken as
 * it is typed, and the field is clamped (or restored when cleared) on blur or
 * Enter — never on each keystroke.
 */
export function NumberDraftInput({ value, min, max, round, onCommit, onBlur, onFocus, onKeyDown, ...rest }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const focus = useRef(0);
  const edit = () => `${id}:${focus.current}`;
  const bounds = { min, max, round };
  const settle = () => {
    if (draft === null) return;
    const next = settledNumber(draft, value, bounds);
    if (next !== value) onCommit(next, edit());
    setDraft(null);
  };
  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onFocus={(event) => {
        focus.current++;
        onFocus?.(event);
      }}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const next = typedNumber(text, bounds);
        if (next !== null && next !== value) onCommit(next, edit());
      }}
      onBlur={(event) => {
        settle();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") settle();
        onKeyDown?.(event);
      }}
    />
  );
}
