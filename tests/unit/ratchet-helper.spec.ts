import { test, expect } from "@playwright/test";
import { baseRef, growth, onMain, readJson, type Entry, type Section } from "../helpers/ratchet";

/**
 * The ratchet helper's own rules (tests/helpers/ratchet.ts), on made-up sections: no ratchet file is read or written.
 * Owner, 14 Oct 21:55 and 22:00: a later date is accepted only with an `extended` record that quotes his word with the date
 * and time; the record moves a date and nothing else.
 */
const WORD = "Owner, 14 Oct 21:55 (resent; addendum 22:00): Move the remaining 11 screen entries' expiry to 30 Nov 2026";
const entry = (over: Partial<Entry> = {}): Entry => ({ count: 3, until: "2026-10-16", by: "someone", ...over });
const base = (): Section => ({ "a.tsx": entry() });
const nothing = { added: [], raised: [], later: [] };

test("RATCHET HELPER · a later date with a valid extended record passes", () => {
  const now: Section = { "a.tsx": entry({ until: "2026-11-30", extended: { from: "2026-10-16", owner: WORD } }) };
  expect(growth(now, base())).toEqual(nothing);
});

test("RATCHET HELPER · a later date without the record fails", () => {
  const now: Section = { "a.tsx": entry({ until: "2026-11-30" }) };
  expect(growth(now, base()).later).toEqual(["a.tsx: 2026-10-16 -> 2026-11-30"]);
});

test("RATCHET HELPER · a record whose `from` is not the base's date fails", () => {
  for (const from of ["2026-10-15", "2026-11-30", "", "2026-10-16 "]) {
    const now: Section = { "a.tsx": entry({ until: "2026-11-30", extended: { from, owner: WORD } }) };
    expect(growth(now, base()).later, `from ${JSON.stringify(from)}`).toHaveLength(1);
  }
});

test("RATCHET HELPER · an owner quote without 'Owner, ' and a date and a time fails", () => {
  const quotes = [
    "",
    "Move the remaining 11 screen entries' expiry to 30 Nov 2026",
    "Owner, 14 Oct: Move the remaining 11 screen entries' expiry to 30 Nov 2026",
    "Owner, Move the remaining 11 screen entries' expiry to 30 Nov 2026",
    "Owner, 21:55: Move the remaining entries",
    "The owner, 14 Oct 21:55: Move the remaining entries",
    "owner, 14 Oct 21:55: Move the remaining entries",
  ];
  for (const owner of quotes) {
    const now: Section = { "a.tsx": entry({ until: "2026-11-30", extended: { from: "2026-10-16", owner } }) };
    expect(growth(now, base()).later, JSON.stringify(owner)).toHaveLength(1);
  }
  const noOwner = { "a.tsx": entry({ until: "2026-11-30", extended: { from: "2026-10-16" } as never }) };
  expect(growth(noOwner, base()).later).toHaveLength(1);
});

test("RATCHET HELPER · an added entry with an extended record still fails", () => {
  const now: Section = { ...base(), "b.tsx": entry({ until: "2026-11-30", extended: { from: "2026-10-16", owner: WORD } }) };
  expect(growth(now, base())).toEqual({ ...nothing, added: ["b.tsx"] });
});

test("RATCHET HELPER · a raised count with an extended record still fails", () => {
  const now: Section = { "a.tsx": entry({ count: 4, until: "2026-11-30", extended: { from: "2026-10-16", owner: WORD } }) };
  expect(growth(now, base())).toEqual({ ...nothing, raised: ["a.tsx: 3 -> 4"] });
  const sameDate: Section = { "a.tsx": entry({ count: 4, extended: { from: "2026-10-16", owner: WORD } }) };
  expect(growth(sameDate, base()).raised).toHaveLength(1);
});

test("RATCHET HELPER · an unchanged or earlier date, and a lowered count, pass without a record", () => {
  const now: Section = { "a.tsx": entry({ count: 2, until: "2026-10-15" }) };
  expect(growth(now, base())).toEqual(nothing);
});

test("RATCHET HELPER · the default base is origin/main; RATCHET_BASE moves it", () => {
  const was = process.env.RATCHET_BASE;
  try {
    delete process.env.RATCHET_BASE;
    expect(baseRef()).toBe("origin/main");
    process.env.RATCHET_BASE = "";
    expect(baseRef()).toBe("origin/main");
    process.env.RATCHET_BASE = "origin/release/1";
    expect(baseRef()).toBe("origin/release/1");
    // A ref that does not exist compares with nothing (the check skips), as a missing origin/main does today.
    process.env.RATCHET_BASE = "no-such-ref-for-ratchet-helper-spec";
    expect(onMain("tests/unit/spend-ratchet.json")).toBeNull();
    // HEAD is where this branch is: the file there is the file here, unless the working tree has an uncommitted change.
    process.env.RATCHET_BASE = "HEAD";
    const there = onMain<Record<string, Section>>("tests/unit/spend-ratchet.json");
    expect(there).not.toBeNull();
    expect(Object.keys(there!).sort()).toEqual(Object.keys(readJson<Record<string, Section>>("tests/unit/spend-ratchet.json")).sort());
  } finally {
    if (was === undefined) delete process.env.RATCHET_BASE;
    else process.env.RATCHET_BASE = was;
  }
});
