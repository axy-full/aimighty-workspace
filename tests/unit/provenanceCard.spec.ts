import { test, expect } from "@playwright/test";
import {
  frameLine, durationLine, seedLine, rulesLine, producedBy,
  canRepeatExactly, repeatNote, makeAnotherHref, NOT_RECORDED,
} from "../../lib/provenanceCard";
import type { Recorded } from "../../lib/provenance";

/* The provenance card (brief 3, surface 1c). Its hardest requirement is the
   opposite of a nice screen: where something was not recorded it says so. */

const rec = (over: Partial<Recorded> = {}): Recorded => ({
  engine: "byteplus", model: "dreamina-seedance-2-5-260628", provider: "byteplus",
  ports: [], cast: [], setup: {}, rules: [],
  conditions: { width: 1920, height: 1080, billedWidth: 1920, billedHeight: 1088, durationSeconds: 5, seed: null },
  by: "someone", at: 0, ...over,
});

test("the frame says both numbers, and only when they differ", () => {
  expect(frameLine(rec().conditions)).toEqual({ file: "1920 × 1080", billed: "1920 × 1088" });
  // A frame the engine metered as it is needs saying once.
  expect(frameLine(rec({ conditions: { ...rec().conditions, billedHeight: 1080 } }).conditions))
    .toEqual({ file: "1920 × 1080", billed: "" });
  expect(frameLine(rec({ conditions: { ...rec().conditions, width: null, height: null } }).conditions).file)
    .toBe(NOT_RECORDED);
});

test("a duration reads as a duration", () => {
  expect(durationLine(5)).toBe("0:05");
  expect(durationLine(65)).toBe("1:05");
  expect(durationLine(null)).toBe(NOT_RECORDED);
  expect(durationLine(0)).toBe(NOT_RECORDED);
});

/* The three facts the schema plan called unrecoverable for old takes. Each
   has to read as absent rather than as zero, empty or none. */
test("what was never written down says so, and never guesses", () => {
  expect(seedLine(null)).toBe(NOT_RECORDED);
  expect(seedLine(41822)).toBe("41822");

  // No rules in scope and no record of them are different answers.
  expect(rulesLine([])).toBe("no rules in scope");
  expect(rulesLine(["a", "b", "c"])).toBe("3 rules");
  expect(rulesLine(["a"])).toBe("1 rule");
  expect(rulesLine(null)).toBe(NOT_RECORDED);
});

test("produced by lists what it was made of, then how", () => {
  const rows = producedBy(rec({ cast: ["Cass", "Workshop"] }));
  expect(rows.map((r) => r.kind)).toEqual(["CITED", "CITED", "ENGINE", "RULES IN SCOPE"]);
  expect(rows[0].value).toBe("Cass");
  expect(rows[0].visual).toBe(true);
  expect(rows[2].visual).toBe(false);
  // A take with nothing recorded has no rows at all rather than empty ones.
  expect(producedBy(null)).toEqual([]);
});

/* Without a seed a take cannot be repeated exactly, and an exact repeat is
   not built at all: "Make another" starts from the prompt in Generate, where
   it is priced, and the footnote says so rather than promising the same seed. */
test("exactly means exactly, and the card promises only what it does", () => {
  expect(canRepeatExactly(rec({ conditions: { ...rec().conditions, seed: 41822 } }))).toBe(true);
  expect(canRepeatExactly(rec())).toBe(false);
  expect(canRepeatExactly(null)).toBe(false);

  expect(repeatNote(rec({ conditions: { ...rec().conditions, seed: 41822 } }))).not.toContain("Same seed");
  expect(repeatNote(rec())).toContain("seed are set again");
  expect(repeatNote(null)).toContain("Nothing else was recorded");
});

test("make another opens Generate in the take's own mode with its prompt", () => {
  expect(makeAnotherHref({ id: "gen_1", kind: "video" })).toBe("/generate?mode=video&promptFrom=gen_1");
  expect(makeAnotherHref({ id: "gen_2", kind: "image" })).toBe("/generate?mode=images&promptFrom=gen_2");
  expect(makeAnotherHref({ id: "gen_3", kind: "audio" })).toBe("/generate?mode=audio&promptFrom=gen_3");
  // Generate does not make 3D models, so there is no door to offer.
  expect(makeAnotherHref({ id: "gen_4", kind: "model" })).toBeNull();
});
