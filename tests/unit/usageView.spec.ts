import { test, expect } from "@playwright/test";
import { blockOf, shotUsage, headlineLine, burnLabel, engineRows, sumBy, type TakeRow } from "../../lib/usageView";

/** Usage, read as a producer would (SOW v2 §7.12, board 12f) — the pure part. */
const cr = (n: number) => `${Math.round(n).toLocaleString()} cr`;
const take = (shotId: string, version: number, reviewState: string, status = "succeeded", extra: Partial<TakeRow> = {}): TakeRow =>
  ({ shotId, code: shotId.toUpperCase(), projectId: "p1", project: "Saltwater", version, reviewState, status, ...extra });

test("a take is one block: approved, picked, draft, sent back, rendering, failed", () => {
  expect(blockOf("approved", "succeeded")).toBe("a");
  expect(blockOf("picked", "succeeded")).toBe("p");
  expect(blockOf("", "succeeded")).toBe("d");
  expect(blockOf("changes", "succeeded")).toBe("x");
  expect(blockOf("", "running")).toBe("r");
  expect(blockOf("picked", "failed")).toBe("f");
});

test("the shots taking the most takes: blocks in take order, the count, the send-backs, the state, most takes first", () => {
  const rows = [
    take("sh03", 1, "changes"), take("sh03", 2, "picked"),
    take("sh06", 1, ""), take("sh06", 2, "changes"), take("sh06", 3, ""), take("sh06", 4, "changes"), take("sh06", 5, "approved"),
    take("sh09", 1, "", "running"),
  ];
  const out = shotUsage(rows, new Map([["sh06", 95], ["sh03", 38]]));
  expect(out.map((s) => s.code)).toEqual(["SH06", "SH03", "SH09"]);
  expect(out[0]).toMatchObject({ blocks: ["d", "x", "d", "x", "a"], versions: [1, 2, 3, 4, 5], takes: 5, sentBack: 2, state: "Approved", credits: 95 });
  expect(out[1]).toMatchObject({ blocks: ["x", "p"], takes: 2, sentBack: 1, state: "Picked", credits: 38 });
  expect(out[2]).toMatchObject({ blocks: ["r"], state: "Draft", credits: 0 });
  expect(shotUsage(rows, new Map(), 2).length, "the top N only").toBe(2);
  /* An approved shot stays Approved in the month after, whatever this month's takes say. */
  expect(shotUsage([take("sh09", 6, "")], new Map(), 8, new Map([["sh09", "Approved"]]))[0].state).toBe("Approved");
});

test("the headline says only what is known", () => {
  expect(headlineLine(832, 1240, 20, cr)).toBe("832 cr spent · 1,240 cr left · about 20 days at this pace");
  expect(headlineLine(832, null, null, cr)).toBe("832 cr spent");
  expect(headlineLine(0, 50, 0, cr)).toBe("0 cr spent · 50 cr left · not a day at this pace");
  expect(headlineLine(12, 9000, 400, cr)).toContain("more than a year");
});

test("the burn-down label: over, under, or honestly unsure", () => {
  expect(burnLabel({ known: true, projected: 372, cap: 400 }, cr)).toEqual({ text: "ends 28 cr under", over: false });
  expect(burnLabel({ known: true, projected: 96, cap: 90 }, cr)).toEqual({ text: "ends 6 cr over its cap", over: true });
  expect(burnLabel({ known: false, projected: null, cap: 90 }, cr)).toEqual({ text: "not enough takes to say", over: false });
  expect(burnLabel({ known: true, projected: 40, cap: 0 }, cr), "a cap of nothing is no cap").toEqual({ text: "not enough takes to say", over: false });
});

test("by engine: models under their labels, planning as its own bar, biggest first, nothing at zero", () => {
  const rows = engineRows([
    { model: "dreamina-seedance-2-5-260628", kind: "video", billedCredits: 400 },
    { model: "dreamina-seedance-2-5-260628", kind: "image", billedCredits: 18 },
    { model: "anthropic/claude-sonnet-5", kind: "text", billedCredits: 11 },
    { model: "fal-ai/kling-video/v3/standard", kind: "video", billedCredits: 48 },
    { model: "x", kind: "video", billedCredits: 0 },
  ], (id) => (id.includes("seedance") ? "Seedance 2.5" : id.includes("kling") ? "Kling 3.0" : id));
  expect(rows).toEqual([{ name: "Seedance 2.5", credits: 418, planning: false }, { name: "Kling 3.0", credits: 48, planning: false }, { name: "Planning", credits: 11, planning: true }]);
  expect(sumBy([{ k: "a", n: 2 }, { k: "b", n: 5 }, { k: "a", n: 1 }], (r) => r.k, (r) => r.n)).toEqual([{ name: "b", credits: 5 }, { name: "a", credits: 3 }]);
});
