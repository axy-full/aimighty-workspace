import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { heartbeatSaveDeadline, STORE_LEASE_MS } from "../../lib/jobs";
import { HEARTBEAT_MAX_DURATION_MS, RECONCILIATION_BUDGET_MS } from "../../lib/reconciliation";
import { PROVIDER_VIDEO_QUEUE_WAIT_MS, PROVIDER_VIDEO_TIMEOUT_MS } from "../../lib/storage";
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

test("a default wait, a whole transfer and its abort leave 5 s of the store lease", () => {
  expect(STORE_LEASE_MS).toBe(180_000);
  expect(PROVIDER_VIDEO_QUEUE_WAIT_MS).toBe(35_000);
  // 35 s wait + 120 s transfer + 20 s abort = 175 s: the row write and
  // inspectOriginalVideo after the save still finish inside the lease.
  expect(STORE_LEASE_MS - (PROVIDER_VIDEO_QUEUE_WAIT_MS + PROVIDER_VIDEO_TIMEOUT_MS + R2_ABORT_TIMEOUT_MS)).toBe(5_000);
});

test("the ceiling in the maths is the heartbeat route's own maxDuration", () => {
  const route = readFileSync("app/api/cron/sync/route.ts", "utf8");
  const declared = /export const maxDuration = (\d+);/.exec(route)?.[1];
  expect(Number(declared) * 1000).toBe(HEARTBEAT_MAX_DURATION_MS);
  // And the sweep's admission deadline is the budget the maths starts from.
  expect(route).not.toMatch(/budgetMs:/);
});
