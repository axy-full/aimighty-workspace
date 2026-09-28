import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionCheckpoint } from "../../lib/admissionTypes";

/* Owner rule, 28 September: whatever Higgsfield quotes Particl in dollars is
   marked up through the existing credit terms and shown to a client in
   credits only. Every Higgsfield cost path prices through
   `marginFor(marginKeyOf(kind, model))` — never at cost — and what a managed
   workspace is shown is credits, never dollars or the terms. No markup value
   is asserted or named here: only that one is applied. */
const directory = mkdtempSync(path.join(tmpdir(), "particl-hf-markup-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "unit-hf-markup-keyring-not-a-real-secret";
process.env.ENGINE_MOCK = "1";

/** A sizable dollar figure, so any markup moves the whole-credit count. */
const USD = 10;
const managed = (): TenantWorkspace => ({
  id: "ws_markup", slug: "ws_markup", name: "Markup", legacy: false, dbUrl: `file:${path.join(directory, "ws.db")}`, dbToken: null, keys: {},
  usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
  flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
} as TenantWorkspace);
async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return await fn(); }
  finally { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
async function modules() {
  return {
    terms: await import("../../lib/creditTerms"),
    billing: await import("../../lib/billingTerms"),
    tenant: await import("../../lib/tenant"),
    admission: await import("../../lib/admissionSupport"),
    models: await import("../../lib/models"),
    genjutsu: await import("../../lib/genjutsuTypes"),
    soul: await import("../../lib/soulIdentities"),
    account: await import("../../lib/higgsfield-consumer/account-billing"),
    tools: await import("../../lib/higgsfield-consumer/website-tools"),
  };
}

test("the Higgsfield API's dollar estimates are quoted in credits with the markup, never at cost", async () => {
  const m = await modules();
  const paths = [
    ...Object.values(m.genjutsu.GENJUTSU_MODELS).map((model) => ({ kind: "video" as const, model })),
    { kind: "image" as const, model: m.models.MARKETING_IMAGE_MODEL_ID },
    { kind: "image" as const, model: m.models.SOUL_CHARACTER_MODEL_ID },
  ];
  await m.tenant.runInTenant(managed(), async () => {
    for (const { kind, model } of paths) {
      const key = m.terms.marginKeyOf(kind, model);
      // The launch terms mark every Higgsfield path up.
      expect(m.terms.marginFor(key, m.terms.DEFAULT_MARGINS), model).toBeGreaterThan(1);
      const marked = m.terms.billCreditsWith(USD, m.terms.marginFor(key), m.terms.creditUsd());
      expect(marked, model).toBeGreaterThan(m.terms.billCreditsWith(USD, 1, m.terms.creditUsd()));
      // The quote a client approves: the admission's one price arithmetic, in credits only.
      let captured: AdmissionCheckpoint | undefined;
      m.admission.admissionCheckpoint(
        { defer: () => {}, checkpoint: (value) => { captured = value; return undefined; } },
        {}, { user: { id: "member" } } as never, kind, USD, model, { model: { id: model, provider: "higgsfield" } },
      );
      expect(captured!.quote, model).toMatchObject({ estimatedCredits: marked, price: marked, unit: "cr" });
      expect(JSON.stringify(captured!.quote), model).not.toMatch(/usd|margin/i);
      // The reservation and its settlement carry the same terms.
      expect(m.billing.creditsAtTerms(USD, m.billing.currentBillingTerms(kind, model)), model).toBe(marked);
    }
    // A Soul ID is trained at its fixed dollar price: in credits with the markup, the dollars never shown.
    const training = m.soul.soulIdentityTerms();
    expect(m.terms.marginFor(m.terms.marginKeyOf("training", null), m.terms.DEFAULT_MARGINS)).toBeGreaterThan(1);
    expect(training.trainingCredits).toBe(m.terms.billCreditsWith(m.soul.SOUL_TRAINING_USD, m.terms.marginFor("identity-training"), m.terms.creditUsd()));
    expect(training).not.toHaveProperty("trainingCostUsd");
  });
});

test("the website account's prices — its own quotes and the private fixed prices — are credits with the markup", async () => {
  const m = await modules();
  const fixed = m.tools.WEBSITE_TOOLS.filter((tool) => tool.pricing === "fixed").map((tool) => tool.id);
  // A synthetic private rate and fixed prices, for this test only.
  await withEnv({ HF_ACCOUNT_CREDIT_USD: "0.02", HF_ACCOUNT_FIXED_CREDITS: JSON.stringify(Object.fromEntries(fixed.map((tool) => [tool, 500]))) }, async () => {
    for (const tool of m.tools.WEBSITE_TOOL_IDS) {
      // D3: a tool the account cannot price itself uses its private fixed price, converted the same way.
      const websiteCredits = m.tools.websiteTool(tool).pricing === "fixed" ? m.account.websiteFixedCredits(tool) : 500;
      const price = m.account.websitePrice(tool, websiteCredits);
      const kind = m.account.websiteMeterKind(tool), model = m.tools.websiteMeterModel(tool);
      const key = m.terms.marginKeyOf(kind, model);
      expect(price.usd, tool).toBeCloseTo(USD, 9);
      expect(m.terms.marginFor(key, m.terms.DEFAULT_MARGINS), tool).toBeGreaterThan(1);
      expect(price.particlCredits, tool).toBe(m.terms.billCreditsWith(USD, m.terms.marginFor(key), m.terms.creditUsd()));
      expect(price.particlCredits, tool).toBeGreaterThan(m.terms.billCreditsWith(USD, 1, m.terms.creditUsd()));
      // The reservation that holds it, and D1's settlement of a failed job, use these same terms.
      expect(m.billing.creditsAtTerms(price.usd, m.billing.currentBillingTerms(kind, model)), tool).toBe(price.particlCredits);
    }
  });
});
