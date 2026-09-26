import { test, expect } from "@playwright/test";
import { buildRateTable } from "../../lib/rateTable.server";
import { takeCost } from "../../lib/breakdownCost";
import { shotCostUsd } from "../../lib/shotCost";
import { ENGINE_MODEL, type ShotEngine } from "../../lib/shotBuilder";
import { billCredits } from "../../lib/creditTerms";

/* A drafted shot's take is priced in the unit the workspace pays in, off the
   rate table the session holds. The draft route used to send the vendor's
   dollars, which a credit workspace printed as credits: a take that bills
   43 cr read "3 cr".

   This spec guards the rate table the page now prices from; it passes on the
   old code too, because takeCost and the table predate the fix. The
   regression tests for the defect itself are moneyRoutes.spec.ts (the draft
   route sends no per-take dollars) and tests/audit-money-workbench.spec.ts
   (the breakdown page shows 43 cr, and no $, in a credit workspace). */
const cr = buildRateTable("cr");
const usd = buildRateTable("usd");
/** What the breakdown page shows for one take in credits: whole, rounded up (lib/price.ts). */
const whole = (n: number) => (n > 0 ? Math.max(1, Math.ceil(n - 1e-9)) : 0);

test("a proposed take in credits is what that take bills, rounded up on its own", () => {
  for (const engine of ["seedance", "kling", "nano-banana"] as ShotEngine[]) {
    for (const planned of [null, 3, 5, 8, 12]) {
      const vendor = shotCostUsd(engine, planned);
      expect(whole(takeCost(cr, planned, engine)), `${engine} ${planned}s`).toBe(billCredits(vendor, ENGINE_MODEL[engine]));
      // A workspace on its own keys still reads its vendors' dollars.
      expect(takeCost(usd, planned, engine)).toBeCloseTo(vendor, 4);
    }
  }
  // The rate card's Seedance 2.5, 5s 1080p line, not the vendor's $2.86.
  expect(whole(takeCost(cr, 5, "seedance"))).toBe(43);
});
