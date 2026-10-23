import { test, expect } from '@playwright/test';
import { textCostUsd, textQuoteCostUsd, type CatalogModel } from '../../lib/catalog';
import { vendorRatesIn } from '../helpers/vendorFigures';

/* Every price here is made up: no catalogue entry has any of them (owner, 23 Oct 2026: no vendor rate in a spec), checked as each model is made. */
function model(pricing: CatalogModel['pricing']): CatalogModel {
  expect(vendorRatesIn(pricing), "a fixture states a catalogue entry's rate").toEqual([]);
  return { id: 'google/gemini-3.1-pro-preview', name: 'Planner', owner: 'google', type: 'language',
    description: '', contextWindow: 1_000_000, maxTokens: 64_000, pricing };
}

test('ordinary, free and input-only base prices retain their existing calculation', () => {
  expect(textCostUsd(model({ input: '0.00000391', output: '0.0000309' }), 8_000, 1_800)).toBeCloseTo(8_000 * .00000391 + 1_800 * .0000309, 10);
  expect(textCostUsd(model({ input: '0', output: 0 }), 8_000, 1_800)).toBe(0);
  expect(textCostUsd(model({ input: .00000391 }), 8_000, 0)).toBe(8_000 * .00000391);
  expect(textCostUsd(model(null), 8_000, 1_800)).toBeNull();
  expect(textCostUsd(model({}), 8_000, 1_800)).toBeNull();
});

// Tier rules as in the public Gateway snapshot, 2026-09-15 (the prices are made up). REST min is inclusive; max is exclusive.
// Gemini's native pricing also explicitly keys its output rate to prompt size.
// https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#tiered-pricing
// https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-pro-preview
test('Gemini switches the price of every input and output token above 200k prompt tokens', () => {
  const m = model({ input: '0.00000391', output: '0.0000309',
    input_tiers: [{ cost: '0.00000391', min: 0, max: 200001 }, { cost: '0.00000929', min: 200001 }],
    output_tiers: [{ cost: '0.0000309', min: 0, max: 200001 }, { cost: '0.0000365', min: 200001 }],
  });
  expect(textCostUsd(m, 200_000, 900)).toBeCloseTo(200_000 * .00000391 + 900 * .0000309, 10);
  expect(textCostUsd(m, 200_001, 900)).toBeCloseTo(200_001 * .00000929 + 900 * .0000365, 10);
  // Large generated output must not select the long-prompt output tier.
  expect(textCostUsd(m, 10, 200_001)).toBeCloseTo(10 * .00000391 + 200_001 * .0000309, 10);
});

test('uses exact Gateway boundaries for GPT 5.6 and Astra rather than hardcoding a rounded threshold', () => {
  for (const [threshold, omitMin] of [[272000, false], [272001, true]] as const) {
    const m = model({ input: .0000227, output: .0000862,
      input_tiers: [{ cost: .0000227, ...(omitMin ? {} : { min: 0 }), max: threshold }, { cost: .0000391, min: threshold }],
      output_tiers: [{ cost: .0000862, ...(omitMin ? {} : { min: 0 }), max: threshold }, { cost: .000137, min: threshold }],
    });
    expect(textCostUsd(m, threshold - 1, 10)).toBeCloseTo((threshold - 1) * .0000227 + 10 * .0000862, 10);
    expect(textCostUsd(m, threshold, 10)).toBeCloseTo(threshold * .0000391 + 10 * .000137, 10);
  }
});

test('accepts independent tier tables and unsorted ranges without mutating the catalog', () => {
  const input = [{ cost: .002, min: 100 }, { cost: .001, max: 100 }];
  const before = JSON.stringify(input);
  expect(textCostUsd(model({ input_tiers: input, output: .003 }), 100, 2)).toBeCloseTo(.206, 10);
  expect(JSON.stringify(input)).toBe(before);
  expect(textCostUsd(model({ input: .001, output_tiers: [{ cost: .003, max: 100 }, { cost: .004, min: 100 }] }), 100, 2)).toBeCloseTo(.108, 10);
  expect(textCostUsd(model({ input_tiers: [{ cost: 0 }], output: 0 }), 0, 0)).toBe(0);
});

test('fails closed on malformed, ambiguous or uncovered declared tiers despite a valid base price', () => {
  const malformed: unknown[] = [null, undefined, {}, [], [null], [[]], [{}],
    [{ cost: '' }], [{ cost: ' ' }], [{ cost: false }], [{ cost: -1 }], [{ cost: 'NaN' }], [{ cost: Infinity }],
    [{ cost: .1, min: null }], [{ cost: .1, min: '0' }], [{ cost: .1, min: -1 }], [{ cost: .1, min: .5 }],
    [{ cost: .1, max: null }], [{ cost: .1, max: '100' }], [{ cost: .1, max: Infinity }], [{ cost: .1, max: 0 }],
    [{ cost: .1, min: 100 }], // no rate for the first range
    [{ cost: .1, max: 100 }, { cost: .2, min: 101 }], // gap
    [{ cost: .1, max: 101 }, { cost: .2, min: 100 }], // overlap
    [{ cost: .1 }, { cost: .2, min: 100 }], // overlapping open range
  ];
  for (const tiers of malformed) for (const key of ['input_tiers', 'output_tiers']) {
    expect(textCostUsd(model({ input: .001, output: .003, [key]: tiers }), 10, 2), `${key}: ${JSON.stringify(tiers)}`).toBeNull();
  }
  expect(textCostUsd(model({ input_tiers: [{ cost: .1, max: 100 }], output: .003 }), 100, 2)).toBeNull();
});

test('invalid token counts and overflowing totals never produce a payable price', () => {
  const m = model({ input: .001, output: .003 });
  for (const count of [-1, Infinity, NaN]) {
    expect(textCostUsd(m, count, 1)).toBeNull();
    expect(textCostUsd(m, 1, count)).toBeNull();
  }
  expect(textCostUsd(model({ input: Number.MAX_VALUE }), 2, 0)).toBeNull();
});


// Direct OpenAI partitions input into ordinary, cache-read and cache-write.
// Each category uses the tier selected by TOTAL prompt size, not its own size.
test('cache read/write rates follow the complete context tier and output already includes reasoning', () => {
  const m = { ...model({ input: .0000227, output: .0000862, input_cache_read: .000000366, input_cache_write: .0000348,
    input_tiers: [{ cost: .0000227, max: 272001 }, { cost: .0000391, min: 272001 }],
    output_tiers: [{ cost: .0000862, max: 272001 }, { cost: .000137, min: 272001 }],
    input_cache_read_tiers: [{ cost: .000000366, max: 272001 }, { cost: .00000391, min: 272001 }],
    input_cache_write_tiers: [{ cost: .0000348, max: 272001 }, { cost: .0000457, min: 272001 }],
  }), id: 'openai/gpt-6-astra' };
  expect(textCostUsd(m, 272000, 200, { cacheReadTokens: 200000, cacheWriteTokens: 50000 })).toBeCloseTo(22000 * .0000227 + 200000 * .000000366 + 50000 * .0000348 + 200 * .0000862, 12);
  expect(textCostUsd(m, 272001, 200, { cacheReadTokens: 200000, cacheWriteTokens: 50000 })).toBeCloseTo(22001 * .0000391 + 200000 * .00000391 + 50000 * .0000457 + 200 * .000137, 12);
  expect(textQuoteCostUsd(m, 272001, 200, true)).toBeCloseTo(272001 * .0000457 + 200 * .000137, 12);
  expect(textQuoteCostUsd(m, 272001, 200)).toBe(textCostUsd(m, 272001, 200));
});

test('cache usage cannot be negative, fractional, overlapping, nonnumeric or priced from missing metadata', () => {
  const m = model({ input: .01, output: .0137, input_cache_read: .001, input_cache_write: .0125 });
  for (const cache of [
    { cacheReadTokens: -1, cacheWriteTokens: 0 }, { cacheReadTokens: .5, cacheWriteTokens: 0 },
    { cacheReadTokens: 80, cacheWriteTokens: 21 }, { cacheReadTokens: NaN, cacheWriteTokens: 0 },
    { cacheReadTokens: 0, cacheWriteTokens: Infinity },
  ]) expect(textCostUsd(m, 100, 20, cache)).toBeNull();
  expect(textCostUsd(model({ input: .01, output: .0137 }), 100, 20, { cacheReadTokens: 1, cacheWriteTokens: 0 })).toBeNull();
  expect(textCostUsd(model({ input: .01, output: .0137 }), 100, 20, { cacheReadTokens: 0, cacheWriteTokens: 1 })).toBeNull();
  expect(textCostUsd(model({ input: .01, output: .0137 }), 100, 20, { cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(100 * .01 + 20 * .0137);
});

test('direct modern quotes reject missing or malformed write metadata while Gateway behavior is unchanged', () => {
  for (const id of ['openai/gpt-5.6-luna', 'openai/gpt-6-astra']) {
    const m = { ...model({ input: .001, output: .003 }), id };
    expect(textQuoteCostUsd(m, 100, 20, true)).toBeNull();
    expect(textQuoteCostUsd(m, 100, 20)).toBeCloseTo(.16);
    for (const write of [null, [], [{ cost: .001, min: 1 }], [{ cost: .001, max: 100 }]]) {
      expect(textQuoteCostUsd({ ...m, pricing: { ...m.pricing, input_cache_write_tiers: write } }, 100, 20, true)).toBeNull();
    }
  }
  expect(textQuoteCostUsd({ ...model({ input: .001, output: .003, input_cache_read: .000185 }), id: 'openai/gpt-4.1' }, 100, 20, true)).toBeCloseTo(.16);
});


test('direct quotes require every applicable price before dispatch, including ordinary input and cache reads', () => {
  const m = { ...model({ input: .001, output: .003, input_cache_read: .000185, input_cache_write: .00125 }), id: 'openai/gpt-6-astra' };
  for (const field of ['input', 'output', 'input_cache_read', 'input_cache_write']) {
    const pricing = { ...m.pricing }; delete pricing[field];
    expect(textQuoteCostUsd({ ...m, pricing }, 100, 20, true)).toBeNull();
  }
});
