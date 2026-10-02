import { test, expect } from "@playwright/test";
import {
  quoteOf, verdictOf, stampOf, isStale, QUOTE_TTL_MS, EMPTY_QUOTE,
  type Terms, type Context,
} from "../../lib/quote";

/* The quote engine (brief 3). The price is on the action, and it is quoted
   before the button enables — so these are the numbers a producer reads and
   then is charged. */

/** Plain terms: ten cents a credit, no margin, so the arithmetic is legible. */
const TERMS: Terms = { perCredit: 0.10, table: { "*": 1 } };
const shot = (key: string, usd: number, engine = "*") => ({ key, usd, engine });

test("one job rounds up to the next tenth of a credit, and never to nothing", () => {
  expect(quoteOf([shot("a", 2.90)], TERMS).totalCredits).toBe(29);
  // Nothing that costs the platform money costs a workspace less than a tenth.
  expect(quoteOf([shot("a", 0.001)], TERMS).totalCredits).toBe(0.1);
  // A fraction over rounds up to the next tenth, not to nearest.
  expect(quoteOf([shot("a", 2.901)], TERMS).totalCredits).toBe(29.1);
  expect(quoteOf([shot("a", 2.91)], TERMS).totalCredits).toBe(29.1);
  // Free is free.
  expect(quoteOf([shot("a", 0)], TERMS).totalCredits).toBe(0);
  expect(quoteOf([], TERMS)).toEqual(EMPTY_QUOTE);
});

/* The handoff's own number: fourteen shots at twenty-nine credits is 406, and
   the approved six are 174. Each shot is its own job, so each rounds on its
   own before anything is added up. */
test("shots round one at a time, and the totals are the ones in the design", () => {
  const fourteen = quoteOf(Array.from({ length: 14 }, (_, i) => shot(`s${i}`, 2.90)), TERMS);
  expect(fourteen.totalCredits).toBe(406);
  expect(fourteen.unitCredits).toBe(29);
  expect(fourteen.units).toBe(14);

  const six = quoteOf(Array.from({ length: 6 }, (_, i) => shot(`s${i}`, 2.90)), TERMS);
  expect(six.totalCredits).toBe(174);
});

/* A batch is one press, so it multiplies before it rounds. Separate shots are
   separate presses and do not. The difference is real money: half a tenth of
   a credit, eight times, is 0.4 credits as a batch and 0.8 as eight shots. */
test("a batch multiplies before rounding; separate shots do not", () => {
  expect(quoteOf([shot("one", 0.005, "*")], TERMS).totalCredits).toBe(0.1);
  expect(quoteOf([{ ...shot("batch", 0.005), count: 8 }], TERMS).totalCredits).toBe(0.4);
  expect(quoteOf(Array.from({ length: 8 }, (_, i) => shot(`s${i}`, 0.005)), TERMS).totalCredits).toBe(0.8);
});

test("a total of many lines in tenths is exact, and a per-unit price stands only when it truly is", () => {
  const ten = quoteOf(Array.from({ length: 10 }, (_, i) => shot(`s${i}`, 0.01)), TERMS);
  expect(ten.totalCredits).toBe(1);        // 0.1 ten times, not 0.9999999999999999
  expect(ten.unitCredits).toBe(0.1);
  const three = quoteOf([shot("a", 0.01), shot("b", 0.02), shot("c", 0.03)], TERMS);
  expect(three.totalCredits).toBe(0.6);     // not 0.6000000000000001
  expect(three.unitCredits).toBeNull();
});

/* The design's copy reads as a rate times a count. Real shots differ in length
   and engine, and the moment they do there is no rate to show — only a sum. */
test("a per-unit price is offered only when every unit really is that price", () => {
  const same = quoteOf([shot("a", 2.90), shot("b", 2.90)], TERMS);
  expect(same.unitCredits).toBe(29);
  expect(same.totalCredits).toBe(58);

  const mixed = quoteOf([shot("a", 2.90), shot("b", 5.80)], TERMS);
  expect(mixed.unitCredits).toBeNull();
  expect(mixed.totalCredits).toBe(87);
  expect(mixed.lines.map((l) => l.credits)).toEqual([29, 58]);
});

test("the margin is the engine's own, and the fallback covers the rest", () => {
  const terms: Terms = { perCredit: 0.10, table: { "*": 1, kling: 2 } };
  expect(quoteOf([shot("a", 1.00, "kling")], terms).totalCredits).toBe(20);
  expect(quoteOf([shot("a", 1.00, "unknown-engine")], terms).totalCredits).toBe(10);
});

/* ── The verdict ──────────────────────────────────────────────────────────
   Not an approximation of the press but the same walls in the same order:
   the approval rule refuses, the monthly allowance refuses, the production's
   cap refuses, and running out of credits does NOT refuse — the take is
   parked as held and released on a top-up. */

const CTX: Context = {
  balance: 1000, allowance: null, caps: {}, warnPct: 80,
  rule: "anyone", shotCap: 50, isAdmin: false,
};
const inProject = (id: string, cap: Partial<Context["caps"][string]> = {}) => ({
  [id]: { cap: null, unit: "cr" as const, spent: 0, rule: "producer" as const, unlocked: false, ...cap },
});

test("a quote inside every rule is allowed, and says only the rule that applies", () => {
  const q = quoteOf([shot("a", 2.90)], TERMS);
  expect(verdictOf(q, CTX)).toMatchObject({ allow: true, gate: "ok", line: "" });
  const v = verdictOf(q, { ...CTX, rule: "cap" });
  expect(v.allow).toBe(true);
  expect(v.line).toContain("50 cr");
});

/* The per-shot rule is about ONE shot's running total. Zeroing that total
   waves through the second take of a shot already at its ceiling; judging the
   set on its sum stops people under a rule the workspace never set. */
test("the approval rule is judged per shot, against that shot's own history", () => {
  const many = quoteOf(
    Array.from({ length: 14 }, (_, i) => ({ ...shot(`s${i}`, 2.90), code: `SH${i}`, spent: 0 })), TERMS);
  expect(verdictOf(many, { ...CTX, rule: "cap", shotCap: 50 }).allow).toBe(true);

  // One shot already at 40 credits: a second 29-credit take puts it over 50.
  const withHistory = quoteOf([
    { ...shot("a", 2.90), code: "SH01", spent: 0 },
    { ...shot("b", 2.90), code: "SH07", spent: 40 },
  ], TERMS);
  const v = verdictOf(withHistory, { ...CTX, rule: "cap", shotCap: 50 });
  expect(v).toMatchObject({ allow: false, gate: "approval" });
  expect(v.line).toContain("SH07");
  expect(v.line).toContain("69 cr");

  // An admin is who the rule defers to, so an admin is never stopped by it.
  expect(verdictOf(withHistory, { ...CTX, rule: "cap", shotCap: 50, isAdmin: true }).allow).toBe(true);
  // And no rule means no gate.
  expect(verdictOf(withHistory, { ...CTX, rule: "anyone", shotCap: 50 }).allow).toBe(true);
});

test("the monthly ceiling on the platform's engines refuses, and counts only what it pays for", () => {
  const q = quoteOf([{ ...shot("a", 40), platformPays: true }], TERMS);
  const v = verdictOf(q, { ...CTX, allowance: { cap: 50, spent: 20 } });
  expect(v).toMatchObject({ allow: false, gate: "allowance" });
  /* The cap and its spend are the vendors' dollars, and the line is read by a workspace billed in
     credits: it says what happened without either figure. */
  expect(v.line).toContain("monthly cap on the platform's engines");
  expect(v.line).not.toMatch(/\$|20|50/);

  // A vendor the workspace holds its own key for is not the platform's money.
  const own = quoteOf([{ ...shot("a", 40), platformPays: false }], TERMS);
  expect(verdictOf(own, { ...CTX, allowance: { cap: 50, spent: 20 } }).allow).toBe(true);
});

/* A change that reaches two productions is two questions. One cap for both is
   how a set is quoted as allowed and then refused halfway through. */
test("each production is judged against its own cap", () => {
  const q = quoteOf([
    { ...shot("a", 2.90), projectId: "p1" },
    { ...shot("b", 2.90), projectId: "p2" },
  ], TERMS);

  // p2 is at its cap; p1 has room. The set is refused because part of it is.
  const v = verdictOf(q, { ...CTX, caps: { ...inProject("p1", { cap: 500 }), ...inProject("p2", { cap: 100, spent: 90 }) } });
  expect(v).toMatchObject({ allow: false, gate: "cap" });

  // With room in both, it goes through.
  expect(verdictOf(q, { ...CTX, caps: { ...inProject("p1", { cap: 500 }), ...inProject("p2", { cap: 500 }) } }).allow).toBe(true);
  // A production with no cap read is not a production with a cap of zero.
  expect(verdictOf(q, { ...CTX, caps: {} }).allow).toBe(true);
});

test("the production's cap blocks, warns, or lets an unlock through", () => {
  const q = quoteOf([{ ...shot("a", 2.90), projectId: "p1" }], TERMS);   // 29 credits

  const over = verdictOf(q, { ...CTX, caps: inProject("p1", { cap: 100, spent: 90 }) });
  expect(over).toMatchObject({ allow: false, gate: "cap" });
  expect(over.line).toContain("unlock");

  const unlocked = verdictOf(q, { ...CTX, caps: inProject("p1", { cap: 100, spent: 90, unlocked: true }) });
  expect(unlocked.allow).toBe(true);
  expect(unlocked.notice).toContain("unlocked");

  const warned = verdictOf(q, { ...CTX, caps: inProject("p1", { cap: 100, spent: 60 }) });
  expect(warned.allow).toBe(true);
  expect(warned.notice).toContain("89%");

  expect(verdictOf(q, { ...CTX, caps: inProject("p1", { cap: 100, spent: 90, rule: "warn" }) }).allow).toBe(true);
  expect(verdictOf(q, { ...CTX, caps: inProject("p1", { cap: 100, spent: 90, rule: "stop" }) }).line).toContain("raise the cap");
});

/* Running out of credits stopped being a refusal when holding was built. The
   work is written down, queued, and released on a top-up. */
test("too few credits holds the work rather than refusing it", () => {
  const q = quoteOf(Array.from({ length: 14 }, (_, i) => shot(`s${i}`, 2.90)), TERMS);
  const v = verdictOf(q, { ...CTX, balance: 100 });
  expect(v).toMatchObject({ allow: true, gate: "held" });
  expect(v.line).toContain("406");
  expect(v.line).toContain("100");
  expect(v.line).toContain("Top up");

  // A workspace that does not pay in credits has no balance to run out of.
  expect(verdictOf(q, { ...CTX, balance: null }).gate).toBe("ok");
  // Nor does one whose engines it holds its own keys for.
  const own = quoteOf(Array.from({ length: 14 }, (_, i) => ({ ...shot(`s${i}`, 2.90), platformPays: false })), TERMS);
  expect(verdictOf(own, { ...CTX, balance: 0 }).gate).toBe("ok");
});

test("a balance that exactly covers jobs priced in tenths is enough: they are summed in whole tenths", () => {
  /* 0.1 + 0.2 in floating point is 0.30000000000000004, which a balance of 0.3 would not cover. */
  const q = quoteOf([shot("a", 0.01), shot("b", 0.02)], TERMS);
  expect(q.lines.map((l) => l.credits)).toEqual([0.1, 0.2]);
  expect(verdictOf(q, { ...CTX, balance: 0.3 }).gate).toBe("ok");
  expect(verdictOf(q, { ...CTX, balance: 0.2 }).gate).toBe("held");
});

test("a refusal beats a hold: the walls are checked in the press's own order", () => {
  // Over the production's cap AND short of credits: the cap is what refuses.
  const q = quoteOf([{ ...shot("a", 2.90), projectId: "p1" }], TERMS);
  expect(verdictOf(q, { ...CTX, balance: 0, caps: inProject("p1", { cap: 10, spent: 9 }) }))
    .toMatchObject({ allow: false, gate: "cap" });
});

test("an empty choice costs nothing and is never blocked", () => {
  const v = verdictOf(quoteOf([], TERMS), {
    ...CTX, balance: 0, allowance: { cap: 1, spent: 99 }, caps: inProject("p1", { cap: 10, spent: 99 }),
  });
  expect(v).toMatchObject({ allow: true, gate: "ok" });
});

/* ── Staleness ──────────────────────────────────────────────────────────── */

test("a quote goes cold when its inputs change or enough time passes", () => {
  const units = [shot("a", 2.90), shot("b", 2.90)];
  const stamp = stampOf(units, TERMS);
  const taken = { pricedAt: 1_000_000, stamp };

  expect(isStale(taken, stamp, 1_000_000)).toBe(false);
  expect(isStale(taken, stamp, 1_000_000 + QUOTE_TTL_MS)).toBe(false);
  expect(isStale(taken, stamp, 1_000_000 + QUOTE_TTL_MS + 1)).toBe(true);

  // A shot added, removed or re-priced makes the old number the wrong number.
  expect(isStale(taken, stampOf([shot("a", 2.90)], TERMS), 1_000_000)).toBe(true);
  expect(isStale(taken, stampOf([shot("a", 3.90), shot("b", 2.90)], TERMS), 1_000_000)).toBe(true);
  // So does the price of a credit moving under it.
  expect(isStale(taken, stampOf(units, { perCredit: 0.2, table: { "*": 1 } }), 1_000_000)).toBe(true);
});
