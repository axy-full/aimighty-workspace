import { test, expect } from "@playwright/test";
import { packs, packById } from "../../lib/packs";
import { nextStatus } from "../../lib/topups";

/** A pack's price is its credits at the fixed rate; a request is answered once. */
test("packs price at the fixed rate", () => {
  process.env.CREDIT_USD = "0.10";
  const all = packs();
  expect(all.map((p) => p.credits)).toEqual([500, 2000, 10000]);
  expect(all.map((p) => p.usd)).toEqual([50, 200, 1000]);
  expect(packById("studio")?.credits).toBe(2000);
  expect(packById("nope")).toBeNull();
});

test("a request moves once, and only from requested", () => {
  expect(nextStatus("requested", "approve")).toBe("approved");
  expect(nextStatus("requested", "decline")).toBe("declined");
  expect(nextStatus("requested", "cancel")).toBe("cancelled");
  expect(nextStatus("approved", "decline")).toBeNull();
  expect(nextStatus("cancelled", "approve")).toBeNull();
});
