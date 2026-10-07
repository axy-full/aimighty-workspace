import { test, expect } from "@playwright/test";
import { looksButton } from "../../components/graphite/board/cards/questions/model";

/*
 * "Show me looks": a spend control is never enabled without its price. Priced it reads "Show me looks · N cr" and
 * presses; unpriced it is disabled with the reason beside it ("Getting the price…" while the server is read).
 */
const idle = { blocked: null, busy: false };

test("priced: the label carries the server's figure and the button is enabled", () => {
  expect(looksButton({ ...idle, words: "43 cr", pricing: "ready" })).toEqual({ label: "Show me looks · 43 cr", disabled: false, why: null });
  expect(looksButton({ ...idle, words: "up to 69 cr", pricing: "ready" }).label).toBe("Show me looks · up to 69 cr");
});

test("while the price is read: disabled, and the reason is Getting the price…", () => {
  expect(looksButton({ ...idle, words: null, pricing: "loading" })).toEqual({ label: "Show me looks", disabled: true, why: "Getting the price…" });
});

test("no price and nothing reading one: disabled with a reason, never an unexplained dead button", () => {
  const none = looksButton({ ...idle, words: null, pricing: "none" });
  expect(none.disabled).toBe(true);
  expect(none.why).toBeTruthy();
});

test("blocked (read-only, nothing left to make): disabled, its own reason shown, priced or not", () => {
  expect(looksButton({ words: null, pricing: "none", blocked: "The four looks are made.", busy: false })).toEqual({ label: "Show me looks", disabled: true, why: "The four looks are made." });
  const priced = looksButton({ words: "12 cr", pricing: "ready", blocked: "Sign in to make looks.", busy: false });
  expect(priced).toMatchObject({ label: "Show me looks · 12 cr", disabled: true, why: "Sign in to make looks." });
});

test("sending: disabled, no price on it, no reason", () => {
  expect(looksButton({ words: "12 cr", pricing: "ready", blocked: "Sending looks…", busy: true })).toEqual({ label: "Sending looks…", disabled: true, why: null });
});

test("an enabled button always has a price", () => {
  for (const pricing of ["none", "loading", "ready", "error"] as const) {
    for (const words of [null, "5 cr", "free"]) {
      for (const blocked of [null, "x"]) {
        for (const busy of [false, true]) {
          const b = looksButton({ words, pricing, blocked, busy });
          if (!b.disabled) expect(b.label).toMatch(/ · /);
        }
      }
    }
  }
});
