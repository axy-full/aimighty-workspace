import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * The published card (CLAUDE.md § Pricing) at the default price of a credit,
 * US$0.10, with CREDIT_USD unset. Every figure comes out of the code that
 * charges it, never typed in:
 *
 *   - a take's price from the server's own admission quote (prepareGeneration,
 *     what /api/generate/quote answers and the reservation charges), and the
 *     same take through the browser's rate table, so the button and the
 *     charge agree;
 *   - the post tools, training and the prompt writer from the public site's
 *     rate card (lib/marketing/prices.server.ts), which uses the same tables;
 *   - plans, the welcome grant, packs and the approval line from the
 *     functions the app reads them through.
 *
 * Local databases and ENGINE_MOCK: nothing is billed and nothing leaves the
 * process.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-rate-card-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const UNSET = ["CREDIT_USD", "CREDIT_PACKS", "SIGNUP_CREDITS"] as const;
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

test.beforeAll(() => {
  for (const key of UNSET) { saved.set(key, process.env[key]); delete process.env[key]; }
  globalThis.fetch = async () => { throw new Error("Network is forbidden in the rate card test"); };
});
test.afterAll(() => {
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  globalThis.fetch = originalFetch;
});

const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};

const SEEDANCE_25 = "dreamina-seedance-2-5-260628";
const KLING_STD = "fal-ai/kling-video/v3/standard";
const NANO_PRO = "gemini-3-pro-image";
const NANO_2 = "gemini-3.1-flash-image";

async function inWorkspace<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, `${name}.db`)}`],
  });
  await grantCredits(name, 10_000, "Rate card test", actor.user.id, "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  return runInTenant(ws, async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
    await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
    return fn();
  }, actor);
}

test("a credit is US$0.10 when CREDIT_USD is unset", async () => {
  const { creditUsd, creditRateLine } = await import("../../lib/creditTerms");
  expect(process.env.CREDIT_USD).toBeUndefined();
  expect(creditUsd()).toBe(0.1);
  expect(creditRateLine(creditUsd())).toBe("1 credit = $0.10");
});

test("the server's quote for a take is the card's price, and the browser's rate table agrees", async () => inWorkspace("rate_card_quotes", async () => {
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const { buildRateTable } = await import("../../lib/rateTable.server");
  const { charged, estimateImage } = await import("../../lib/rateTable");
  const { estimateComposerVideo } = await import("../../lib/composerQuote");
  const table = buildRateTable("cr");
  expect(table.creditUsd).toBe(0.1);

  const takes: [string, Record<string, unknown>, number, number | null][] = [
    ["Seedance 2.5 · 1080p · 5 s", { model: SEEDANCE_25, resolution: "1080p", ratio: "16:9", duration: 5, generateAudio: true }, 43,
      charged(table, estimateComposerVideo(table, SEEDANCE_25, "1080p", "16:9", 5, true, []))],
    ["Kling 3.0 Standard · 1080p · 5 s", { model: KLING_STD, resolution: "1080p", ratio: "16:9", duration: 5 }, 7,
      charged(table, estimateComposerVideo(table, KLING_STD, "1080p", "16:9", 5, false, []))],
    ["Nano Banana Pro · 1K", { model: NANO_PRO, resolution: "1K", ratio: "16:9" }, 3, charged(table, estimateImage(table, NANO_PRO, "1K"))],
    ["Nano Banana 2 · 512", { model: NANO_2, resolution: "512", ratio: "16:9" }, 1, charged(table, estimateImage(table, NANO_2, "512"))],
  ];
  for (const [what, body, card, browser] of takes) {
    const quote = await prepareGeneration({ prompt: "A lighthouse at dusk, slow push in", projectId: "project", refine: false, ...body }, actor);
    expect(quote.ok, `${what}: ${JSON.stringify(quote)}`).toBe(true);
    if (!quote.ok) continue;
    expect(quote.value.quote.unit, what).toBe("cr");
    expect(quote.value.quote.estimatedCredits, what).toBe(card);
    expect(browser, `${what} on the button`).toBe(card);
  }
}));

test("the published rate card, from the code", async () => {
  const { sitePrices } = await import("../../lib/marketing/prices.server");
  const { rateCard, hero, perCredit } = await sitePrices();
  expect(perCredit).toBe(0.1);
  const row = (action: string, spec: string) => rateCard.find((r) => r.action === action && r.spec === spec)?.credits;
  expect(row("Seedance 2.5", "5 s · 1080p")).toBe(43);
  expect(hero.credits).toBe(43);
  expect(row("Kling 3.0 Standard", "5 s · 1080p")).toBe(7);
  expect(row("Keyframe still", "Nano Banana Pro · 1K")).toBe(3);
  expect(row("Standard still", "Nano Banana 2 · 512")).toBe(1);
  expect(row("Topaz upscale", "5 s · 1080p")).toBe(23);
  expect(row("Topaz upscale", "5 s · 4K")).toBe(38);
  expect(rateCard.find((r) => r.action === "Identity training")?.credits).toBe(54);
  expect(row("Prompt enhancement", "per prompt")).toBe(1);
});

test("plans, the welcome grant, the Starter pack and the approval line at US$0.10", async () => {
  const { DEFAULT_PLANS } = await import("../../lib/plans");
  const { signupCredits, creditUsd } = await import("../../lib/creditTerms");
  const { packs } = await import("../../lib/packs");
  const { JOB_APPROVAL_LINE_USD, jobApprovalLineCredits } = await import("../../lib/approvalRule");

  expect(DEFAULT_PLANS.map((p) => [p.label, p.priceUsd, p.includedCredits])).toEqual([
    ["Invite", 0, 0], ["Studio", 49, 400], ["Agency", 199, 1600], ["Production", 999, 9000],
  ]);
  /* Invite's 250 are the one-time welcome grant, not an inclusion (lib/plans.ts). */
  expect(signupCredits()).toBe(250);

  const starter = packs().find((p) => p.id === "starter")!;
  expect([starter.usd, starter.credits, starter.bonus]).toEqual([50, 500, 0]);

  expect(JOB_APPROVAL_LINE_USD).toBe(20);
  expect(jobApprovalLineCredits(creditUsd())).toBe(200);
});
