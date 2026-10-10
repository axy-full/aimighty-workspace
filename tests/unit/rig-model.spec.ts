import { test, expect } from "@playwright/test";
import { impactPrice, lengthOf, stepPriceText } from "../../components/v12/rig/model";

/** The Rig's money wording (redesign P5): what a change costs, and what a step cost. */
const two = [{ nodeId: "a" }, { nodeId: "b" }];
const asked = { a: {}, b: {} };

test("a change's price: ready only when every read is back; an error says why; a shot with no request is quoted", () => {
  expect(impactPrice(two, asked, { a: { credits: 3 }, b: { credits: 4, approximate: true } })).toEqual({ state: "ready", total: 7, approximate: true });
  expect(impactPrice(two, asked, { a: { credits: 3 } })).toEqual({ state: "loading" });
  /* One failed read is an error, not a price that loads forever. */
  expect(impactPrice(two, asked, { a: { credits: 3 }, b: { error: "The price could not be read. Try again." } })).toEqual({ state: "error", message: "The price could not be read. Try again.", ids: ["b"] });
  /* A take with no recorded request has nothing to quote: "quoted", never a dash with an error. */
  expect(impactPrice(two, { a: {} }, { a: { credits: 3 } })).toEqual({ state: "quoted" });
  expect(impactPrice([], {}, {})).toEqual({ state: "quoted" });
});

const take = (status: "failed" | "review" | "rendering", over: Record<string, unknown> = {}) => ({ status, nothingBilled: false, charge: null, ...over }) as Parameters<typeof stepPriceText>[0];

test("a step's price: a failed or cancelled take charged nothing says Nothing billed, never zero", () => {
  expect(stepPriceText(take("failed"), { status: "failed", creditsBilled: 0, costUsd: 0 }, false)).toBe("Nothing billed");
  expect(stepPriceText(take("failed"), { status: "cancelled", creditsBilled: 0, costUsd: 0 }, false)).toBe("Nothing billed");
  expect(stepPriceText(take("failed", { nothingBilled: true }), { status: "failed" }, false)).toBe("Nothing billed");
  expect(stepPriceText(take("failed", { charge: "Charged by its provider" }), { status: "failed" }, false)).toBe("Charged by its provider");
  const charged = stepPriceText(take("review"), { status: "succeeded", creditsBilled: 9, costUsd: 0.9 }, false);
  expect(charged).toMatch(/9/);
  expect(charged).not.toBe("Nothing billed");
  expect(stepPriceText(take("failed"), { status: "failed", creditsBilled: 5 }, false)).toMatch(/5/);
  expect(stepPriceText(take("rendering"), { status: "running" }, false)).toBe("not billed yet");
});

test("a shot's length is read from its line when the script gives one", () => {
  expect(lengthOf("2 · 0:04 · 4 s · Locked off")).toBe("4 s");
  expect(lengthOf("2 · 0:04 · 2.5 s")).toBe("2.5 s");
  expect(lengthOf("2 · Locked off")).toBeNull();
});
