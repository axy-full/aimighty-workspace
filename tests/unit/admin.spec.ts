import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The platform's view across workspaces: spend, billed, margin, and which engines fail. */
const dir = mkdtempSync(path.join(tmpdir(), "particl-admin-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";

const workspace = (id: string, own = false) => ({
  id, slug: id, name: id, legacy: false, dbUrl: process.env.TURSO_DATABASE_URL, dbToken: null,
  keys: own ? { ark: "own" } : {}, usesPlatformKeys: !own, allowanceUsd: null, gatewayKeyId: null, ownerId: "u", createdAt: 0,
  suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});

test("spend, billed and failures are summed per workspace, engine health per engine", async () => {
  const { meter, meterByWorkspace, engineHealth, marginUsd } = await import("../../lib/meter");
  const { runInTenant } = await import("../../lib/tenant");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = workspace("ws_a") as any, b = workspace("ws_b", true) as any;
  const sd = "dreamina-seedance-2-5-260628";
  await runInTenant(a, () => meter({ id: "a1", kind: "video", engine: "byteplus", model: sd, status: "succeeded", engineCostUsd: 2.864, durationMs: 40_000 }));
  await runInTenant(a, () => meter({ id: "a2", kind: "video", engine: "byteplus", model: sd, status: "failed", engineCostUsd: 0, durationMs: 5_000 }, { critical: false }));
  await runInTenant(a, () => meter({ id: "a3", kind: "image", engine: "vercel", model: "gemini-3-pro-image", status: "succeeded", engineCostUsd: 0.134, durationMs: 3_000 }));
  await runInTenant(b, () => meter({ id: "b1", kind: "video", engine: "byteplus", model: sd, status: "succeeded", engineCostUsd: 2.864, durationMs: 41_000 }));
  const by = await meterByWorkspace(0);
  const wa = by.get("ws_a")!;
  expect(wa.jobs).toBe(3); expect(wa.failed).toBe(1);
  expect(wa.engineCostUsd).toBeCloseTo(2.998, 3);
  expect(wa.billedCredits).toBe(46); // 43 + 3
  /* Fully funded: every credit this workspace holds was bought, so the whole
     of its spend is revenue. */
  expect(marginUsd(wa.billedCredits, wa.engineCostUsd, 0.1, 1)).toBeCloseTo(1.602, 3);
  /* Half its credits were given. Half the same spend is revenue, and this
     workspace is in fact losing money — which the old figure hid. */
  expect(marginUsd(wa.billedCredits, wa.engineCostUsd, 0.1, 0.5)).toBeCloseTo(-0.698, 3);
  const wb = by.get("ws_b")!;
  expect(wb.billedCredits).toBe(0); // its own key paid
  expect(wb.engineCostUsd).toBe(0); // not the platform's money
  const health = await engineHealth(0);
  const seed = health.find((h) => h.model === sd)!;
  expect(seed.jobs).toBe(3); expect(seed.failed).toBe(1);
  expect(seed.failRate).toBeCloseTo(1 / 3, 5);
  expect(seed.avgMs).toBeCloseTo(40_500, 0);
});
