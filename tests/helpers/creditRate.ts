import { test } from "@playwright/test";

/**
 * Price a credit at `value` for one spec file's tests, and put it back after.
 * `undefined` runs them at the default (DEFAULT_CREDIT_USD in lib/creditTerms.ts).
 *
 * Never as a top-level `process.env.CREDIT_USD = ...`: `playwright test`
 * imports every spec file in the runner before it forks a worker, and a worker
 * inherits the runner's environment, so one file's top-level assignment priced
 * the whole unit suite and no test ran at the default. These hooks run in the
 * worker, around this file only.
 */
export function pinCreditUsd(value: string | undefined): void {
  let before: string | undefined;
  test.beforeAll(() => {
    before = process.env.CREDIT_USD;
    setCreditUsd(value);
  });
  test.afterAll(() => setCreditUsd(before));
}

/** Set CREDIT_USD, or unset it for `undefined`. */
export function setCreditUsd(value: string | undefined): void {
  if (value === undefined) delete process.env.CREDIT_USD;
  else process.env.CREDIT_USD = value;
}
