import { test, expect } from "@playwright/test";
import { limitVerdict, quotaVerdict, limitsFor, GB } from "../../lib/limits";
import { DEFAULT_CAPS } from "../../lib/platformLayer";

/** The rate refuses, a full pipeline waits, a full store refuses; a workspace's own numbers win. */
test("the rate limit refuses and the concurrency limit waits", () => {
  const limits = { concurrency: 4, rendersPerHour: 60, storageBytes: 50 * GB };
  expect(limitVerdict({ running: 2, startedLastHour: 10, limits })).toEqual({ allow: true });
  const slots = limitVerdict({ running: 4, startedLastHour: 10, limits });
  expect(slots.allow).toBe(false);
  expect(!slots.allow && slots.why).toBe("slots");
  const rate = limitVerdict({ running: 0, startedLastHour: 60, limits });
  expect(!rate.allow && rate.why).toBe("rate");
  expect(!rate.allow && rate.error).toContain("60 renders");
});

test("the quota counts what is coming in", () => {
  expect(quotaVerdict({ usedBytes: 49 * GB, quotaBytes: 50 * GB, incomingBytes: 0.5 * GB }).allow).toBe(true);
  const full = quotaVerdict({ usedBytes: 49.8 * GB, quotaBytes: 50 * GB, incomingBytes: 0.5 * GB });
  expect(full.allow).toBe(false);
  expect(full.error).toContain("49.8 GB of 50.0 GB");
  expect(quotaVerdict({ usedBytes: 1, quotaBytes: 0, incomingBytes: 1 }).allow).toBe(true);
  expect(quotaVerdict({ usedBytes: 8_050_029, quotaBytes: 1_000_000, incomingBytes: 0 }).error).toContain("8 MB of 1 MB");
});

test("a workspace's own numbers override the platform's", () => {
  const platform = limitsFor(null, DEFAULT_CAPS);
  expect(platform).toEqual({ concurrency: DEFAULT_CAPS.concurrency, rendersPerHour: DEFAULT_CAPS.rendersPerHour, storageBytes: DEFAULT_CAPS.storageGb * GB });
  const own = limitsFor({ concurrency: 8, rendersPerHour: null, storageQuotaBytes: 10 * GB }, DEFAULT_CAPS);
  expect(own).toEqual({ concurrency: 8, rendersPerHour: DEFAULT_CAPS.rendersPerHour, storageBytes: 10 * GB });
});
