import { test, expect } from "@playwright/test";
import { ELEMENT_KINDS } from "../../lib/copy";
import { ELEMENT_KIND_IDS, enginesByKind, enginesForKind, isElementKind } from "../../lib/elementEngines";

/*
 * The Director's engine list per element kind (owner's note of 26 Oct 2026, item 6d; SOW v2 §9 Elements, Part II.4, cited only):
 * read from the private policy by kind through ENGINES_BY_KIND, no mapping in the repo, an empty kind shows nothing, never a
 * default. The ids below are placeholders, not engines.
 */

const OFFERED = new Set(["engine-a", "engine-b", "engine-c", "engine-d"]);
const env = (value: unknown) => ({ ENGINES_BY_KIND: typeof value === "string" ? value : JSON.stringify(value) });

test("the eight kinds, as the copy table names them", () => {
  expect(ELEMENT_KIND_IDS).toEqual(["cast", "prop", "environment", "vehicle", "wardrobe", "product", "words", "world"]);
  expect(Object.keys(ELEMENT_KINDS).filter((key) => key !== "question")).toEqual([...ELEMENT_KIND_IDS]);
  expect(isElementKind("cast")).toBe(true);
  for (const bad of ["character", "location", "Cast", "", null, 1]) expect(isElementKind(bad), String(bad)).toBe(false);
});

test("each kind shows only its own list, in the policy's order, less what this deployment does not offer", () => {
  const policy = env({ cast: ["engine-b"], environment: ["engine-c", "engine-a", "engine-gone"], words: ["engine-d"], world: [] });
  expect(enginesForKind("cast", OFFERED, policy)).toEqual(["engine-b"]);
  expect(enginesForKind("environment", OFFERED, policy)).toEqual(["engine-c", "engine-a"]);
  expect(enginesForKind("words", OFFERED, policy)).toEqual(["engine-d"]);
  /* A kind listed empty, or not listed, shows nothing: never a default, never the whole catalogue. */
  expect(enginesForKind("world", OFFERED, policy)).toEqual([]);
  for (const kind of ["prop", "vehicle", "wardrobe", "product"]) expect(enginesForKind(kind, OFFERED, policy), kind).toEqual([]);
  /* A repeated id is offered once. */
  expect(enginesForKind("cast", OFFERED, env({ cast: ["engine-b", "engine-b", "engine-a"] }))).toEqual(["engine-b", "engine-a"]);
});

test("unset, unreadable or not the shape: every kind shows nothing", () => {
  const cases: Record<string, string | undefined>[] = [
    {}, { ENGINES_BY_KIND: "" }, { ENGINES_BY_KIND: "   " }, env("{not json"), env("[]"), env("null"),
    env({ cast: "engine-a" }), env({ character: ["engine-a"] }), env({ cast: [7] }), env({ cast: ["Engine A"] }),
    env({ cast: Array.from({ length: 13 }, (_, i) => `engine-${i}`) }),
  ];
  for (const value of cases) {
    expect(enginesByKind(value), JSON.stringify(value)).toBeNull();
    for (const kind of ELEMENT_KIND_IDS) expect(enginesForKind(kind, OFFERED, value), `${JSON.stringify(value)} ${kind}`).toEqual([]);
  }
  /* An unknown kind asked for shows nothing, whatever the policy says. */
  expect(enginesForKind("character", OFFERED, env({ cast: ["engine-a"] }))).toEqual([]);
});

test("read when asked: a change to the variable applies on the next read", () => {
  const live: Record<string, string | undefined> = env({ cast: ["engine-a"] });
  expect(enginesForKind("cast", OFFERED, live)).toEqual(["engine-a"]);
  live.ENGINES_BY_KIND = JSON.stringify({ cast: ["engine-c"] });
  expect(enginesForKind("cast", OFFERED, live)).toEqual(["engine-c"]);
});
