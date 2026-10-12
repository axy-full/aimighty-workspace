import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PROCESSOR_NAME_EXCEPTIONS, bannedNamesIn, uiWordsIn } from "../helpers/uiStrings";

/**
 * The one exception to the ban on vendor names in UI text (tests/helpers/uiStrings.ts; the owner's decision of 11 October 2026):
 * the privacy page may name the service that receives prompts or files. This spec holds it to that: one file, one processor name,
 * nothing else of the ban list, and no other file.
 */
const HIGGSFIELD = ["Higgs", "field"].join("");
const SOUL = ["So", "ul"].join("");
const PERSONA = ["Per", "sona"].join("");
const MARKETING = ["Marketing", " Studio"].join("");
const PAGE = "app/(app)/privacy/page.tsx";
const say = (word: string) => `export const a = <p>${word}, by its API</p>;`;

test("the exception is exactly one file and one processor name", () => {
  expect(PROCESSOR_NAME_EXCEPTIONS).toEqual({ [PAGE]: [HIGGSFIELD] });
});

test("the privacy page may name the processor, in either scan", () => {
  expect(bannedNamesIn(PAGE, say(HIGGSFIELD)).map((h) => h.word)).toEqual([]);
  expect(uiWordsIn(PAGE, say(HIGGSFIELD)).map((h) => h.word)).toEqual([]);
});

test("no other file may, and no other banned name may be said on that page", () => {
  for (const other of ["app/(app)/terms/page.tsx", "components/graphite/Header.tsx", "app/(app)/privacy/other.tsx", "privacy/page.tsx", "app\\(app)\\privacy\\page.tsx", "./app/(app)/privacy/page.tsx"]) {
    expect(bannedNamesIn(other, say(HIGGSFIELD)).map((h) => h.word), other).toEqual([HIGGSFIELD]);
    expect(uiWordsIn(other, say(HIGGSFIELD)).map((h) => h.word), other).toEqual([HIGGSFIELD]);
  }
  for (const word of [SOUL, PERSONA, MARKETING, HIGGSFIELD.toUpperCase(), "Moleculr"]) {
    expect(bannedNamesIn(PAGE, say(word)).length, word).toBeGreaterThan(0);
  }
});

test("the page as it stands says nothing else from the ban list", () => {
  const source = readFileSync(PAGE, "utf8");
  expect(bannedNamesIn(PAGE, source)).toEqual([]);
  expect(uiWordsIn(PAGE, source).map((h) => h.word)).toEqual([]);
});
