import { test, expect } from "@playwright/test";
import { cleanSpec } from "../../lib/setup";
import { CATEGORIES } from "../../lib/studio";

const KEY = CATEGORIES[0].key;
const OTHER = CATEGORIES[1].key;

test("a Setup off the wire keeps only the keys the camera bank offers", () => {
  const got = cleanSpec({ [KEY]: "ws", nonsense: "x", __proto__: "y" });
  expect(Object.keys(got)).toEqual([KEY]);
});

test("null survives, because null is an explicit clear", () => {
  /* brief 2.3: a layer setting a key to null CLEARS it for the layers below,
     which is not the same as the key being absent. Dropping nulls here would
     silently turn "the production says: no camera move" into "the production
     says nothing", and the workspace's move would come back. */
  const got = cleanSpec({ [KEY]: null, [OTHER]: "eye" });
  expect(got).toHaveProperty(KEY, null);
  expect(got[OTHER]).toBe("eye");
});

test("a value that is not a string is dropped, not coerced", () => {
  const got = cleanSpec({ [KEY]: 42, [OTHER]: { nested: true } });
  expect(got).toEqual({});
});

test("a long value is bounded rather than rejected", () => {
  const got = cleanSpec({ [KEY]: "x".repeat(500) });
  expect((got[KEY] as string).length).toBe(120);
});

test("garbage in is an empty Setup, never a throw", () => {
  for (const junk of [null, undefined, "", "nope", 7, [], [{ [KEY]: "ws" }]]) {
    expect(cleanSpec(junk)).toEqual({});
  }
});

test("an unknown key is dropped, so a retired camera-bank category degrades", () => {
  /* The camera bank is platform data and can lose a category between two
     deploys. A stored Setup naming one that no longer exists should come back
     as the rest of itself, not fail. */
  const got = cleanSpec({ [KEY]: "ws", retiredCategory: "whatever" });
  expect(got).toEqual({ [KEY]: "ws" });
});
