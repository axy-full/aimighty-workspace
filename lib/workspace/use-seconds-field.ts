"use client";
import { useState, type ChangeEvent } from "react";

/**
 * A length field that can be typed into freely. While it has focus the text
 * follows the keys; every change that reads as a number is committed at once
 * (the composer's reducer holds it to the model's range, so the price follows);
 * on blur the field shows the committed value, which is the value billed.
 */
export function useSecondsField(value: number, commit: (seconds: number) => void) {
  const [text, setText] = useState<string | null>(null);
  return {
    value: text ?? String(value),
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setText(next);
      const seconds = Number(next);
      if (next.trim() !== "" && Number.isFinite(seconds)) commit(seconds);
    },
    onBlur: () => setText(null),
  };
}
