import { test, expect } from "@playwright/test";
import { setClip, getClip, consumeClip } from "../../lib/clipboard";

/**
 * The app's clipboard (docs/change-request-1.md §10): one slot; a cut is
 * spent by its paste, a copy can be pasted again.
 */
test("a copy stays after a paste, a cut is spent by it", () => {
  setClip({ kind: "shot", mode: "copy", id: "sh1", label: "SH-010" });
  expect(getClip()).toMatchObject({ kind: "shot", mode: "copy", id: "sh1" });
  expect(getClip()!.at).toBeGreaterThan(0);
  expect(consumeClip()?.id).toBe("sh1");
  expect(getClip()?.id, "a copy can be pasted again").toBe("sh1");
  setClip({ kind: "media", mode: "cut", id: "g1", label: "take 3", payload: { kind: "video" } });
  expect(consumeClip()).toMatchObject({ id: "g1", mode: "cut", payload: { kind: "video" } });
  expect(getClip(), "a cut is spent by its paste").toBeNull();
  expect(consumeClip()).toBeNull();
});

test("setting the slot to nothing empties it", () => {
  setClip({ kind: "asset", mode: "copy", id: "el1", label: "@Mira" });
  setClip(null);
  expect(getClip()).toBeNull();
});
