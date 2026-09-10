import { test, expect } from "@playwright/test";
import { monthRange, monthOf, groupLines, statementCsv, type RawLine, type Statement } from "../../lib/statements";

const line = (o: Partial<RawLine>): RawLine => ({
  id: "g1", at: Date.UTC(2026, 8, 6), kind: "video", take: "v1", what: "Seedance 2.5 · 1080P · 5s", status: "succeeded", note: "", credits: 40, usd: 0,
  projectId: "p1", projectName: "Northline", shotId: "s1", shotCode: "SH010", shotTitle: "Rooftop", ...o,
});

test("a month is a UTC month", () => {
  const r = monthRange("2026-09")!;
  expect(new Date(r.from).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  expect(new Date(r.to).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  expect(monthRange("2026-13")).toBeNull();
  expect(monthRange("nope")).toBeNull();
  expect(monthOf(Date.UTC(2026, 8, 30, 23, 59))).toBe("2026-09");
});

test("lines group by production and shot, Unfiled last, shots by code, takes in order", () => {
  const rows = [
    line({ id: "a", at: 3, projectId: null, projectName: "", shotId: null, shotCode: "" }),
    line({ id: "b", at: 2, shotCode: "SH020", shotId: "s2", shotTitle: "" }),
    line({ id: "c", at: 1 }),
    line({ id: "d", at: 4, projectId: "p0", projectName: "Alpha", shotId: null, shotCode: "", credits: 3 }),
  ];
  const g = groupLines(rows);
  expect(g.map((p) => p.name)).toEqual(["Alpha", "Northline", "Unfiled"]);
  const n = g[1];
  expect(n.shots.map((s) => s.code)).toEqual(["SH010", "SH020"]);
  expect(n.credits).toBe(80);
  expect(n.takes).toBe(2);
  expect(g[2].loose.map((l) => l.id)).toEqual(["a"]);
});

test("the CSV escapes what needs escaping and ends with the totals", () => {
  const s: Statement = {
    month: "2026-09", from: 0, to: 1, unit: "cr", workspace: { name: "Studio", slug: "studio" }, projectFilter: null,
    projects: groupLines([line({ id: "x", shotTitle: 'Rooftop, "wide"', credits: 40 })]),
    totals: { credits: 40, usd: 0, takes: 1 }, packs: { count: 1, credits: 500, bonus: 0, usd: 50 },
  };
  const csv = statementCsv(s);
  expect(csv.split("\r\n")[0]).toBe("date,production,shot,take,what,status,credits");
  expect(csv).toContain('"SH010 Rooftop, ""wide"""');
  expect(csv).toContain("total,,40");
  // Starter carries no bonus, so the line stays a single number.
  expect(csv).toContain("packs this month (1),,500 credits · USD 50.00");
});

test("a pack's free half is on the statement, not just its bought half", () => {
  /* §7A puts the discount in bonus credits, so `topup_requests.credits` is
     the BOUGHT half only. A statement that summed that alone told a
     workspace it received 20,000 credits in a month its balance rose by
     24,000 — and this is the document a workspace sends to its own client,
     so it is the last place that can afford to disagree with the balance.
     Both halves, and a dollar figure covering only the bought one. */
  const s: Statement = {
    month: "2026-09", from: 0, to: 1, unit: "cr", workspace: { name: "Studio", slug: "studio" }, projectFilter: null,
    projects: groupLines([line({ id: "x", credits: 40 })]),
    totals: { credits: 40, usd: 0, takes: 1 }, packs: { count: 1, credits: 20000, bonus: 4000, usd: 2000 },
  };
  expect(statementCsv(s)).toContain("packs this month (1),,24000 credits (20000 bought + 4000 free) · USD 2000.00");
});
