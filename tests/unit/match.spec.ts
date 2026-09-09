import { test, expect } from "@playwright/test";
import { score, rank } from "../../lib/match";

/* The palette's ranking (SOW §10 4.2). Nothing in the repo did this before —
   every other "search" is String.includes — so these are the three ways
   people actually type at a palette, and the order they must come back in. */

test("a prefix beats a word start beats a substring", () => {
  const s = (t: string) => score(t, "cam")!.score;
  expect(s("Camera bank")).toBeGreaterThan(s("The camera bank"));
  expect(s("The camera bank")).toBeGreaterThan(s("Uncamera"));
});

test("initials find a thing nobody would type in full", () => {
  /* The case the old String.includes could not do at all: "dz" is not a
     substring of "Dolly zoom". */
  expect(score("Dolly zoom", "dz")).not.toBeNull();
  expect(score("Dolly zoom", "dz")!.at).toEqual([0, 6]);
  expect(score("Nike — AW26 launch", "nal")).not.toBeNull();
});

test("a real substring always beats letters merely in order", () => {
  const substring = score("Bleach bypass", "bypass")!.score;
  const scattered = score("Bleach bypass", "bbs")!.score;
  expect(substring).toBeGreaterThan(scattered);
});

test("what does not match at all comes back null", () => {
  expect(score("Rooftop wide", "zzz")).toBeNull();
  // Every letter present but out of order is still not a match.
  expect(score("abc", "cba")).toBeNull();
});

test("an empty needle matches everything, unranked", () => {
  /* The palette opens empty and must show its default list rather than
     nothing. */
  expect(score("anything", "")).toEqual({ score: 0, at: [] });
});

test("the matched positions are returned so a hit can be shown", () => {
  expect(score("Rooftop wide", "wide")!.at).toEqual([8, 9, 10, 11]);
});

test("rank orders best first and keeps the caller's order on ties", () => {
  const items = [{ n: "The camera bank" }, { n: "Camera bank" }, { n: "Cast" }];
  const out = rank(items, "cam", (x) => [x.n]);
  expect(out.map((o) => o.item.n)).toEqual(["Camera bank", "The camera bank"]);
});

test("a second key finds a thing without outranking its own name", () => {
  /* Found by its production is worth less than found by its own name, or a
     search for a production name would bury the production itself. */
  const shots = [
    { code: "SH010", production: "Nike" },
    { code: "NIKE-1", production: "Other" },
  ];
  const out = rank(shots, "nike", (s) => [s.code, s.production]);
  expect(out[0].item.code).toBe("NIKE-1");
  expect(out.map((o) => o.item.code)).toContain("SH010");
});

test("nothing matching returns an empty list, not everything", () => {
  expect(rank([{ n: "a" }, { n: "b" }], "zzz", (x) => [x.n])).toEqual([]);
});
