import { test, expect } from "@playwright/test";
import { nextAccount, type WorkspaceAccount } from "../../lib/workspace/data";
import { creditsLabel, formatCredits } from "../../lib/workspace/format";

/**
 * The header's credit balance: how it is written, and what it says when there
 * is no figure to write. The slot is never empty — a phone that hides what the
 * next tap will spend is the defect this covers.
 */

test("a balance reads in credits, mono-friendly and grouped en-US", () => {
  expect(creditsLabel(2250).text).toBe("2,250 cr");
  expect(creditsLabel(2250).known).toBe(true);
  expect(creditsLabel(1234567).text).toBe("1,234,567 cr");
  expect(creditsLabel(19.6).text).toBe("20 cr");
  expect(formatCredits(2250)).toBe("2,250 cr");
});

test("zero is a balance, not an unknown", () => {
  expect(creditsLabel(0).text).toBe("0 cr");
  expect(creditsLabel(0).known).toBe(true);
});

test("no balance yet reads as a neutral placeholder, never as nothing", () => {
  for (const missing of [null, undefined, Number.NaN]) {
    const label = creditsLabel(missing);
    expect(label.text).toBe("— cr");
    expect(label.known).toBe(false);
    expect(label.title).toMatch(/unavailable/i);
    expect(label.text.trim().length).toBeGreaterThan(0);
  }
});

test("a workspace billed in dollars holds no credits, and the slot says so", () => {
  const label = creditsLabel(null, "usd");
  expect(label.text).toBe("—");
  expect(label.known).toBe(false);
  expect(label.title).toMatch(/dollars/i);
  /* A balance says what somebody HAS; it is never what they pay in
     (lib/price.ts), so a dollar workspace is not given a credit figure. */
  expect(creditsLabel(2250, "usd").text).toBe("—");
});

/* ── The refresh ────────────────────────────────────────────────────────── */

const account: WorkspaceAccount = { workspace: { id: "ws1", name: "Studio" }, credits: { balance: 2250 } };

test("a refresh with a balance takes it", () => {
  const next = nextAccount(account, { workspace: { id: "ws1", name: "Studio" }, credits: { balance: 2100 } });
  expect(next.credits).toEqual({ balance: 2100 });
});

test("a refresh with no balance keeps the one already on screen", () => {
  const next = nextAccount(account, { workspace: { id: "ws1", name: "Studio" }, credits: null });
  expect(next.credits).toEqual({ balance: 2250 });
  expect(nextAccount(account, { workspace: { id: "ws1", name: "Studio" } }).credits).toEqual({ balance: 2250 });
});

test("another workspace never inherits this one's balance", () => {
  const next = nextAccount(account, { workspace: { id: "ws2", name: "Other" }, credits: null });
  expect(next.workspace).toEqual({ id: "ws2", name: "Other" });
  expect(next.credits).toBeNull();
  expect(nextAccount(account, { workspace: null, credits: null }).credits).toBeNull();
});

test("a balance that is not a number is no balance", () => {
  const blank: WorkspaceAccount = { workspace: { id: "ws1", name: "Studio" }, credits: null };
  expect(nextAccount(blank, { workspace: { id: "ws1", name: "Studio" }, credits: { balance: "2,250" } }).credits).toBeNull();
  expect(creditsLabel(nextAccount(blank, { workspace: { id: "ws1", name: "Studio" }, credits: {} }).credits?.balance ?? null).text).toBe("— cr");
});
