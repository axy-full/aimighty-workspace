import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { heartbeatSaveDeadline } from "../../lib/jobs";
import { HEARTBEAT_MAX_DURATION_MS, RECONCILIATION_BUDGET_MS } from "../../lib/reconciliation";
import { PROVIDER_VIDEO_TIMEOUT_MS } from "../../lib/storage";
import { R2_ABORT_TIMEOUT_MS } from "../../lib/storage/r2";

/* The heartbeat may start a provider save only while the whole save, and an
 * abort after it, still fits inside the route's own ceiling. */

test("the heartbeat starts saves until 160 s into its sweep: deadlineAt + 20 s", () => {
  const start = 1_000_000;
  const deadlineAt = start + RECONCILIATION_BUDGET_MS;
  expect(RECONCILIATION_BUDGET_MS).toBe(140_000);
  expect(PROVIDER_VIDEO_TIMEOUT_MS).toBe(120_000);
  expect(R2_ABORT_TIMEOUT_MS).toBe(20_000);
  expect(heartbeatSaveDeadline(deadlineAt)).toBe(start + 160_000);
  expect(heartbeatSaveDeadline(deadlineAt)).toBe(deadlineAt + 20_000);
  // The last save started then ends, aborted at worst, exactly at the route's ceiling.
  expect(heartbeatSaveDeadline(deadlineAt) + PROVIDER_VIDEO_TIMEOUT_MS + R2_ABORT_TIMEOUT_MS).toBe(start + HEARTBEAT_MAX_DURATION_MS);
});

test("the ceiling in the maths is the heartbeat route's own maxDuration", () => {
  const route = readFileSync("app/api/cron/sync/route.ts", "utf8");
  const declared = /export const maxDuration = (\d+);/.exec(route)?.[1];
  expect(Number(declared) * 1000).toBe(HEARTBEAT_MAX_DURATION_MS);
  // And the sweep's admission deadline is the budget the maths starts from.
  expect(route).not.toMatch(/budgetMs:/);
});
