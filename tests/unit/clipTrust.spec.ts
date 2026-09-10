import { test, expect } from "@playwright/test";
import { clipDoubt, clipDoubtMessage, floorSeconds } from "../../lib/clipTrust";

const MB = 1_048_576;

/**
 * A clip's declared length is bytes the uploader chose, and upscale and
 * reframe are priced by the second of it.
 */
test("a length that never parsed cannot be priced against", () => {
  /* The whole cheap attack. Every ceiling in lib/tasks.ts is written
     `seconds != null && seconds > max`, so a null sails past all of them and
     the estimate falls back to a few seconds. Unpriceable is not cheap. */
  expect(clipDoubt(null, 50 * MB)).toBe("unknown");
  expect(clipDoubt(undefined, 50 * MB)).toBe("unknown");
  expect(clipDoubt(0, 50 * MB)).toBe("unknown");
  expect(clipDoubt(-4, 50 * MB)).toBe("unknown");
});

test("a length its own file cannot hold is a lie", () => {
  /* Not a guess about compression: at 120 Mbit/s — above 4K ProRes in an
     mp4, far above any delivery codec — 150 MB is at least ten seconds of
     video whatever is in it. Declaring four is contradicted by the bytes. */
  expect(clipDoubt(4, 150 * MB)).toBe("impossible");
  expect(clipDoubt(2, 200 * MB)).toBe("impossible");
});

test("real files are not refused", () => {
  // A 5s 1080p delivery clip, ~10 Mbit/s.
  expect(clipDoubt(5, 6 * MB)).toBeNull();
  // A 300s clip at a modest bitrate — long and small, the honest version of
  // the attack's shape, and it must pass.
  expect(clipDoubt(300, 37 * MB)).toBeNull();
  // A 4K ProRes-ish 10s file: big and short, which is also legitimate.
  expect(clipDoubt(10, 140 * MB)).toBeNull();
});

test("with no size to argue with, a stated length is taken", () => {
  // The bound is the file's own size; without one there is nothing to check
  // it against, and refusing every clip would break the feature entirely.
  expect(clipDoubt(5, null)).toBeNull();
  expect(clipDoubt(5, 0)).toBeNull();
});

test("the floor is the bytes, not the codec", () => {
  expect(floorSeconds(120_000_000 / 8)).toBeCloseTo(1, 6);
  expect(floorSeconds(0)).toBe(0);
  expect(floorSeconds(-1)).toBe(0);
});

test("the message says what to do and does not teach the bound", () => {
  const a = clipDoubtMessage("unknown", "Upscale");
  const b = clipDoubtMessage("impossible", "Upscale");
  for (const m of [a, b]) {
    expect(m).toContain("Re-export it as an MP4");
    expect(m, "no bitrate to tune a forgery against").not.toMatch(/bitrate|Mbit|120/);
  }
  expect(a).toContain("length could not be read");
  expect(b).toContain("does not match its size");
});
