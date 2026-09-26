import { test, expect } from "@playwright/test";
import { retimedClip, settledNumber, typedNumber } from "../../lib/workbench/number-draft";

const music = { min: 10, max: 300 };
const gain = { min: -60, max: 12, round: true };

test("typing a length takes only in-range values, so 45 stays 45 instead of becoming 105", () => {
  /* Each keystroke of "45": the "4" is below the minimum and is not taken; "45" is. */
  expect(typedNumber("4", music)).toBeNull();
  expect(typedNumber("45", music)).toBe(45);
  expect(typedNumber("", music)).toBeNull();
  expect(typedNumber("301", music)).toBeNull();
  /* A negative gain can be typed from a cleared field: "-" waits, "-6" is taken. */
  expect(typedNumber("-", gain)).toBeNull();
  expect(typedNumber("-6", gain)).toBe(-6);
  expect(typedNumber("-6.4", gain)).toBe(-6);
  expect(typedNumber("0.3", { min: -1, max: 1 })).toBe(0.3);
});

test("leaving a field clamps what was typed, and a cleared field keeps its value", () => {
  expect(settledNumber("4", 30, music)).toBe(10);
  expect(settledNumber("900", 30, music)).toBe(300);
  expect(settledNumber("", 30, music)).toBe(30);
  expect(settledNumber("-", 0, gain)).toBe(0);
  expect(settledNumber("-80", 0, gain)).toBe(-60);
  expect(settledNumber("12.6", 0, gain)).toBe(12);
  expect(settledNumber("45", 30, music)).toBe(45);
});

test("typing a clip Duration of 25 passes through 2 without losing its 6-frame fades", () => {
  /* SoundMix takes each in-range keystroke; every one is clamped from the fades the edit began with. */
  const start = { fadeIn: 6, fadeOut: 6 };
  expect(retimedClip(start, 2)).toEqual({ duration: 2, fadeIn: 2, fadeOut: 0 });
  expect(retimedClip(start, 25)).toEqual({ duration: 25, fadeIn: 6, fadeOut: 6 });
  /* A length that truly is shorter still clamps. */
  expect(retimedClip(start, 10)).toEqual({ duration: 10, fadeIn: 6, fadeOut: 4 });
  expect(retimedClip({ fadeIn: 0, fadeOut: 0 }, 1)).toEqual({ duration: 1, fadeIn: 0, fadeOut: 0 });
});
