import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { runInTenant, type TenantWorkspace } from "../../lib/tenant";
import { getModel } from "../../lib/models";
import { estimateImageCostUsd } from "../../lib/vendorPricing";
import { billCredits, creditUsd } from "../../lib/creditTerms";
import { NO_REFERENCES, quoteWorkbenchMedia, quoteWorkbenchMediaAtCost, workbenchRate } from "../../lib/workbench/media-quote";

/**
 * The house workspace sees every price at cost (lib/houseWorkspace.ts); a customer sees credits. One take, one number: the
 * button's price, the hold on its card and what it settled at are the same figure, in the unit the workspace is in.
 * A Nano Banana 2 still at 512: the engine's cost is the house's price, the margin and the rounding up to a whole credit
 * are the customer's.
 */
const NB2 = "gemini-3.1-flash-image";
const model = getModel(NB2);
const params = { resolution: "512", ratio: "1:1", duration: 0 };

test("the quote: customers get credits only, the house also gets the engine's dollars, the same figure admission reserves", () => {
  const customer = quoteWorkbenchMedia(model, { ...params, ratio: model.ratios[0], resolution: model.resolutions[0] }, NO_REFERENCES);
  const house = quoteWorkbenchMediaAtCost(model, { ...params, ratio: model.ratios[0], resolution: model.resolutions[0] }, NO_REFERENCES);
  const hold = estimateImageCostUsd(NB2, model.resolutions[0], 0)!.net;
  /* A customer is never sent a vendor cost. */
  expect(customer).not.toHaveProperty("usd");
  expect(JSON.stringify(customer)).not.toContain(String(hold));
  /* The house's dollars are the reservation's (admission: estimateImageCostUsd(...).net), and its credits are the customer figure. */
  expect(house.usd).toBe(hold);
  expect(house.credits).toBe(customer.credits);
  expect(customer.credits).toBe(billCredits(hold, NB2));
  /* The model sheet's rows: dollars only when asked for at cost. */
  expect(workbenchRate(model, {}, NO_REFERENCES)).not.toHaveProperty("usd");
  expect(workbenchRate(model, { atCost: true }, NO_REFERENCES)?.usd).toBeGreaterThan(0);
});



/* The route itself: the engines route sends the house the engine's dollars and a customer never. */
async function enginesRoute() {
  const dependencies: Record<string, unknown> = {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireUser: async () => ({ user: { id: "u" } }) },
    "@/lib/providers": { modelConfigured: () => true },
    /* References are read from the workspace's database; with none attached there is nothing to read. */
    "@/lib/workbench/media-quote": { ...(await import("../../lib/workbench/media-quote")), referencePrices: async () => NO_REFERENCES },
    "@/lib/soulIdentities": { requireReadySoulIdentity: async () => undefined },
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/cinemaSoundPricing": await import("../../lib/cinemaSoundPricing"),
    "@/lib/credits": await import("../../lib/credits"),
  };
  const compiled = ts.transpileModule(readFileSync(path.resolve("app/api/workbench/engines/route.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as { GET: (req: Request) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => { if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`); return dependencies[name]; }, mod, mod.exports);
  return mod.exports.GET;
}
const workspace = (id: string): TenantWorkspace => ({ id, slug: id, name: id, legacy: false, dbUrl: "file:/nonexistent/never-opened.db", dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
  ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null } as TenantWorkspace);

test("the engines route: the house gets the engine's dollars (one take, and on the sheet's rows), a customer workspace never does", async () => {
  const GET = await enginesRoute();
  const url = `http://localhost/api/workbench/engines?model=${NB2}&resolution=${model.resolutions[0]}&ratio=${model.ratios[0]}`;
  const hold = estimateImageCostUsd(NB2, model.resolutions[0], 0)!.net;
  const house = await runInTenant(workspace("ws_legacy"), async () => (await GET(new Request(url))).json()) as { credits: number; usd?: number; models: { id: string; rate?: { usd?: number } | null }[] };
  expect(house.usd).toBe(hold);
  expect(house.credits).toBe(billCredits(hold, NB2));
  const customer = await runInTenant(workspace("ws_customer"), async () => (await GET(new Request(url))).json()) as { credits: number; usd?: number };
  expect(customer).not.toHaveProperty("usd");
  expect(customer.credits).toBe(house.credits);
  /* The sheet's rows. */
  const list = "http://localhost/api/workbench/engines";
  const houseRows = await runInTenant(workspace("ws_legacy"), async () => (await GET(new Request(list))).json()) as { models: { id: string; rate?: { usd?: number } | null }[] };
  const customerRows = await runInTenant(workspace("ws_customer"), async () => (await GET(new Request(list))).json()) as { models: { id: string; rate?: { usd?: number } | null }[] };
  expect(houseRows.models.some((m) => typeof m.rate?.usd === "number")).toBe(true);
  expect(customerRows.models.every((m) => !m.rate || !("usd" in m.rate))).toBe(true);
  expect(JSON.stringify(customerRows)).not.toMatch(/"usd"/);
});





test("Atomik's thinking: the planner's dollars reach the house's price read beside its credits; a credit workspace reads credits only", async () => {
  const { thinkingFrom } = await import("../../lib/shell/thinking-price");
  const body = { agent: { enabled: true, ask: { planning: 4, planningUsd: 0.373 } } };
  expect(thinkingFrom(body)).toEqual({ state: "ready", credits: 4, usd: 0.373 });
  /* A credit workspace is never sent the dollars, and never reads them. */
  expect(thinkingFrom({ agent: { enabled: true, ask: { planning: 4 } } })).toEqual({ state: "ready", credits: 4 });
  /* The press still approves the credits: the dollars change what is shown, not the limit. */
  expect(thinkingFrom(body)).toMatchObject({ credits: 4 });
});

/*
 * Moved here when the prototype-12 build was deleted (23 Oct 2026; docs/old-shells.md). These asserted that build's own price layer
 * (lib/v12/make.ts makeQuote, lib/v12/quote.ts priceDisplay and planningQuote, lib/v12/renderState.ts), which went with it. Where the
 * live shell has the rule, the test named here covers it; the rest has no home until v31.16 draws these surfaces, and stays as fixme.
 */
const NO_HOME = "no home: the prototype-12 price layer that drew it is deleted (23 Oct 2026); owner question: does v31.16 carry it, or is it dropped?";
test.fixme(`house: the button, the hold on the card and the settled charge are one figure, at cost — ${NO_HOME} (the house's "no figure without the engine's dollars" is live: tests/unit/houseDollars.spec.ts)`, () => {});
test.fixme(`customer: the button, the hold and the settled charge are one figure, in credits; dollars sent beside a customer's quote never change what they see — ${NO_HOME}`, () => {});
test.fixme(`a take in flight says "Charged only when it's ready" (Cinema Studio: "Charged what the engine reports") under its held figure — ${NO_HOME}`, () => {});
test.fixme(`the house is never shown the customer price in dollars: "—" with its reason, "up to $…" for an estimate, "Pays at cost" on hover — ${NO_HOME} (live in lib/shell/price-words.ts: tests/unit/houseDollars.spec.ts)`, () => {});
test.fixme(`Cinema Studio for the house: "about $0.42, at most $1.26" in the engine's dollars — ${NO_HOME}`, () => {});
test.fixme(`a cancel on its way keeps the held figure and says it settles when the engine confirms, never "charged only when ready"; with no figure it says only that — ${NO_HOME}`, () => {});
test.fixme(`Atomik's thinking for the house reads "up to $…" with "Pays at cost", or "—" with its reason when the planner's dollars are missing — ${NO_HOME}`, () => {});

test("the planner's ceiling reaches the house in dollars beside its credits, and a customer workspace never receives the dollars", async () => {
  /* The planner is priced the way a plan reserves it: the mock planner's price under ENGINE_MOCK=1. Without it (CI's unit job sets none) the price comes from
     the deployment's keys and catalogue, of which a test machine has neither, so the figure is rightly absent: this test sets what it needs and puts back what
     an earlier spec in the same worker left, in the other direction too. */
  const names = ["ENGINE_MOCK", "RIG_AGENT_ENABLED", "TEXT_DIRECT", "MODEL_CATALOG", "VERCEL", "VERCEL_OIDC_TOKEN", "AI_GATEWAY_API_KEY"] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  process.env.ENGINE_MOCK = "1";
  process.env.RIG_AGENT_ENABLED = "1";
  try {
    const { newBoardAskTerms } = await import("../../lib/workbench/rig-agent");
    const asked = async (id: string) => runInTenant(workspace(id), () => newBoardAskTerms());
    const house = await asked("ws_legacy");
    const customer = await asked("ws_customer");
    expect(house.ask?.planning ?? 0).toBeGreaterThan(0);
    expect(house.ask?.planningUsd ?? 0).toBeGreaterThan(0);
    /* The customer's credits carry the margin; the house's are its dollars counted in whole credits (lib/credits.ts quotedCredits). */
    expect(customer.ask?.planning ?? 0).toBeGreaterThanOrEqual(house.ask?.planning ?? 0);
    expect(Math.ceil((house.ask!.planningUsd as number) / creditUsd() - 1e-9)).toBe(house.ask?.planning);
    expect(customer.ask).not.toHaveProperty("planningUsd");
    expect(JSON.stringify(customer)).not.toContain("planningUsd");
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
});

