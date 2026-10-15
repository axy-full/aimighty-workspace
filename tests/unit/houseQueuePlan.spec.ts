import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The approvals queue's plan item (lib/control-room/approvals.server.ts planGateFigures): a customer workspace reads credits, the house reads the plan's dollars
 * at cost, and the house's "at most" is the ENFORCED ceiling (the quote's credits) at the credit's price, rounded up, the very words the plan card shows
 * (creditsText in dollar mode): never below what can be charged.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-house-queue-plan-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.CREDIT_USD;

/* One $0.84 render is 9 cr (rounded up to a whole $0.10 credit), so the enforced ceiling is 18 cr: $1.80, not 2 x $0.84. */
const QUOTE = { total: 9, ceiling: 18, approximate: false, totalUsd: 0.84 };

test("the house's plan item: its total in dollars, its ceiling the enforced one, in the card's words", async () => {
  const { planGateFigures } = await import("../../lib/control-room/approvals.server");
  const { creditsText, priceWords } = await import("../../lib/shell/price-words");
  const house = planGateFigures(QUOTE, false);
  expect(house.price).toEqual({ kind: "exact", credits: 9, usd: 0.84 });
  expect(priceWords(house.price, { on: true, creditUsd: 0.1 })).toBe("$0.84");
  expect(house.note).toBe("At most $1.80 with fixes");
  /* The same wording the plan card gives the same plan's ceiling. */
  expect(house.note).toBe(`At most ${creditsText(QUOTE.ceiling, { on: true, creditUsd: 0.1 })} with fixes`);
  /* An estimate keeps its "up to"; a quote with no dollar figure has no price, and the note still words the enforced ceiling. */
  expect(planGateFigures({ ...QUOTE, approximate: true }, false).price).toEqual({ kind: "up-to", credits: 9, usd: 0.84 });
  expect(planGateFigures({ total: 9, ceiling: 18, approximate: false }, false)).toEqual({ price: null, note: "At most $1.80 with fixes" });
});

test("a customer's plan item stays in credits, with no dollar figure", async () => {
  const { planGateFigures } = await import("../../lib/control-room/approvals.server");
  const customer = planGateFigures(QUOTE, true);
  expect(customer).toEqual({ price: { kind: "exact", credits: 9 }, note: "At most 18 cr with fixes" });
  expect(JSON.stringify(customer)).not.toMatch(/usd|\$/);
  expect(planGateFigures({ ...QUOTE, approximate: true }, true).price).toEqual({ kind: "up-to", credits: 9 });
});
