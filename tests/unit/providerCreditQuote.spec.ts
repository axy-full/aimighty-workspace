import { test, expect } from "@playwright/test";
import {
  providerCreditQuote,
  formatProviderCreditQuote,
  sumWithProviderCreditQuotes,
  type ProviderCreditQuote,
} from "../../lib/providerCreditQuote";
import type { TenantWorkspace } from "../../lib/tenant";

const quote = (credits: number): ProviderCreditQuote => ({
  provider: "higgsfield",
  unit: "higgsfield_credits",
  basis: "approved_quote",
  credits,
});

test("a provider quote retains its explicit unit, precision and non-invoice label", () => {
  const value = quote(1075.125);
  expect(providerCreditQuote(value)).toEqual(value);
  expect(formatProviderCreditQuote(value)).toBe(
    "1,075.125 connected cr (quoted)",
  );
  expect(formatProviderCreditQuote(quote(0))).toBe("0 connected cr (quoted)");
});

test("invalid quote discriminators and nonnumeric, negative or nonfinite values cannot acquire the provider label", () => {
  for (const invalid of [
    null,
    undefined,
    false,
    "75",
    75,
    [],
    {},
    { ...quote(75), provider: "fal" },
    { ...quote(75), unit: "particl_credits" },
    { ...quote(75), unit: "usd" },
    { ...quote(75), basis: "paid_invoice" },
    { ...quote(75), basis: undefined },
    { ...quote(75), credits: "75" },
    { ...quote(75), credits: null },
    { ...quote(75), credits: -1 },
    { ...quote(75), credits: NaN },
    { ...quote(75), credits: Infinity },
    { ...quote(75), credits: -Infinity },
  ])
    expect(providerCreditQuote(invalid)).toBeNull();
});

test("mixed totals keep provider quotes separate from USD and Particl credits without counting either twice", () => {
  const ordinary = Object.freeze({
    costUsd: 3.5,
    creditsBilled: 8,
    providerCreditQuote: null,
  });
  const provider = Object.freeze({
    costUsd: 999,
    creditsBilled: 999,
    providerCreditQuote: Object.freeze(quote(75)),
  });
  const second = Object.freeze({
    costUsd: 999,
    creditsBilled: 999,
    providerCreditQuote: Object.freeze(quote(1.25)),
  });
  const list = [ordinary, provider, second];
  const received: unknown[] = [];
  expect(
    sumWithProviderCreditQuotes(list, (standard) => {
      received.push(standard);
      return `$${standard.reduce((sum, row) => sum + row.costUsd, 0).toFixed(2)}`;
    }),
  ).toBe("$3.50 + 76.25 connected cr (quoted)");
  expect(
    sumWithProviderCreditQuotes(list, (standard) => {
      received.push(standard);
      return `${standard.reduce((sum, row) => sum + row.creditsBilled, 0)} Particl cr`;
    }),
  ).toBe("8 Particl cr + 76.25 connected cr (quoted)");
  expect(received).toEqual([[ordinary], [ordinary]]);
  expect(list).toEqual([ordinary, provider, second]);
});

test("provider-only totals do not add a fictitious zero-dollar subtotal; empty and invalid-quote rows retain the base formatter", () => {
  let baseCalls = 0;
  expect(
    sumWithProviderCreditQuotes(
      [{ providerCreditQuote: quote(75) }, { providerCreditQuote: quote(0) }],
      () => {
        baseCalls++;
        return "$0.00";
      },
    ),
  ).toBe("75 connected cr (quoted)");
  expect(baseCalls).toBe(0);
  expect(
    sumWithProviderCreditQuotes([], (rows) => {
      expect(rows).toEqual([]);
      return "0 cr";
    }),
  ).toBe("0 cr");
  const malformed = {
    providerCreditQuote: {
      ...quote(3),
      unit: "usd",
    } as unknown as ProviderCreditQuote,
  };
  expect(
    sumWithProviderCreditQuotes([malformed], (rows) => {
      expect(rows).toEqual([malformed]);
      return "$2.00";
    }),
  ).toBe("$2.00");
});

test("server mapping labels only completed consumer originals and suppresses incompatible ledger amounts in either workspace mode", async () => {
  const { rowToGeneration } = await import("../../lib/jobs");
  const { runInTenant } = await import("../../lib/tenant");
  const workspace: TenantWorkspace = {
    id: "quote-display",
    slug: "quote-display",
    name: "Quote display",
    legacy: false,
    dbUrl: "file:unused-quote-display.db",
    dbToken: null,
    keys: {},
    usesPlatformKeys: true,
    allowanceUsd: null,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: null,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
    gatewayKeyId: null,
    ownerId: "owner",
    createdAt: 0,
  };
  const row = {
    id: `gen_hfc_${"a".repeat(40)}`,
    provider: "higgsfield",
    model: "marketing_studio_video",
    kind: "video",
    status: "succeeded",
    cost_usd: 99,
    refine_cost_usd: 1,
    params: JSON.stringify({
      consumerCredits: 75,
      consumerCreditUnit: "higgsfield_credits",
    }),
    created_at: 0,
    updated_at: 0,
  };
  for (const legacy of [false, true]) {
    await runInTenant({ ...workspace, legacy }, async () => {
      const mapped = rowToGeneration(row);
      expect(mapped.providerCreditQuote).toEqual(quote(75));
      expect(mapped.costUsd).toBeNull();
      expect(mapped.refineCostUsd).toBeNull();
      expect(mapped.creditsBilled).toBeNull();
      for (const patch of [
        { id: "ordinary-generation" },
        { provider: "fal" },
        { model: "another-model" },
        { status: "running" },
        {
          params: JSON.stringify({
            consumerCredits: -1,
            consumerCreditUnit: "higgsfield_credits",
          }),
        },
        {
          params: JSON.stringify({
            consumerCredits: 75,
            consumerCreditUnit: "usd",
          }),
        },
      ])
        expect(
          rowToGeneration({ ...row, ...patch }).providerCreditQuote,
        ).toBeNull();
    });
  }
});
