import { test, expect } from "@playwright/test";
import { plannedTakeUsd, plannedLine, MIN_BILLED_SECONDS } from "../../lib/shotBudget";
import { estimateCostUsd, DEFAULT_MODEL_ID } from "../../lib/models";

const price = (usd: number) => `${Math.round(usd * 100)}c`;

/** A shot written in Atomik arrives on the wall with what one take of it would cost (brief 2.6). */
test("the planned budget is one take at the default engine, five seconds at least", () => {
  expect(plannedTakeUsd(8)).toBe(estimateCostUsd(DEFAULT_MODEL_ID, "1080p", "16:9", 8)!.net);
  expect(plannedTakeUsd(3)).toBe(estimateCostUsd(DEFAULT_MODEL_ID, "1080p", "16:9", MIN_BILLED_SECONDS)!.net);
  expect(plannedTakeUsd(null)).toBe(plannedTakeUsd(MIN_BILLED_SECONDS));
  expect(plannedTakeUsd(0)).toBe(plannedTakeUsd(MIN_BILLED_SECONDS));
});

test("the wall says what is planned and what it will cost, or just the cost when nothing is planned", () => {
  expect(plannedLine(8, price)).toBe(`no takes yet · 8s planned · ${price(plannedTakeUsd(8))} a take`);
  expect(plannedLine(null, price)).toBe(`no takes yet · ${price(plannedTakeUsd(null))} a take`);
});
