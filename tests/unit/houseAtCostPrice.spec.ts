import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { runInTenant, type TenantWorkspace } from "../../lib/tenant";
import { getModel } from "../../lib/models";
import { estimateImageCostUsd } from "../../lib/vendorPricing";
import { billCredits, creditUsd } from "../../lib/creditTerms";
import { NO_REFERENCES, quoteWorkbenchMedia, quoteWorkbenchMediaAtCost, workbenchRate } from "../../lib/workbench/media-quote";
import { makeQuote } from "../../lib/v12/make";
import { NO_AT_COST_PRICE, PAYS_AT_COST, priceDisplay } from "../../lib/v12/quote";
import { exact } from "../../lib/shell/price-words";
import { fmtLedgerUsd } from "../../lib/usageLedgerTerms";
import { fmtRenderPrice, moneyLine, renderState, type RenderTake } from "../../lib/v12/renderState";

/**
 * The house workspace sees every price at cost (lib/houseWorkspace.ts); a customer sees credits. One take, one number: the
 * button's price, the hold on its card and what it settled at are the same figure, in the unit the workspace is in.
 * A Nano Banana 2 still at 512: the engine's cost is the house's price, the margin and the rounding up to a whole credit
 * are the customer's.
 */
const NB2 = "gemini-3.1-flash-image";
const model = getModel(NB2);
const params = { resolution: "512", ratio: "1:1", duration: 0 };
const ENV = (dollars: boolean) => ({ creditUsd: creditUsd(), dollars: fmtLedgerUsd, _dollars: dollars });
const at = (take: Partial<RenderTake>): RenderTake => ({ id: "g", status: "running", kind: "image", model: NB2, provider: "google", createdAt: 0, ...take } as RenderTake);

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

test("house: the button, the hold on the card and the settled charge are one figure, at cost", () => {
  const usd = estimateImageCostUsd(NB2, model.resolutions[0], 0)!.net;
  const quote = quoteWorkbenchMediaAtCost(model, { resolution: model.resolutions[0], ratio: model.ratios[0], duration: 0 }, NO_REFERENCES);
  /* The button's price: the quote's credits would read the customer's price in dollars; the quote's dollars read the engine's. */
  const button = priceDisplay(makeQuote(exact(quote.credits!), { dollars: true, creditUsd: creditUsd() }, quote.usd), undefined, ENV(true))!.text;
  /* Without the engine's dollars the house is shown no figure, never the customer price (credits at the margin, as dollars). */
  const without = priceDisplay(makeQuote(exact(quote.credits!), { dollars: true, creditUsd: creditUsd() }), undefined, ENV(true))!.text;
  expect(without).toBe("—");
  expect(without).not.toBe(fmtLedgerUsd(quote.credits! * creditUsd()));
  /* The hold: what admission reserved (the meter's engine cost), as the card words it. */
  const held = renderState(at({ price: { amount: usd, unit: "usd" } }), 70_000).money!.text;
  /* The settled charge: the take's cost in dollars, as the tray words it. */
  const settled = fmtRenderPrice({ amount: usd, unit: "usd" });
  expect(button).toBe(settled);
  expect(held).toBe(`${settled} held · charged only when it’s ready`);
  expect(renderState(at({ status: "running", price: { amount: usd, unit: "usd" } }), 70_000).tile).toBe(`Rendering · 1:10 so far · ${settled} held`);
  /* A batch of takes is the take's dollars times the count. */
  expect(priceDisplay(makeQuote(exact(quote.credits! * 3), { dollars: true, creditUsd: creditUsd() }, quote.usd! * 3), undefined, ENV(true))!.text).toBe(fmtLedgerUsd(usd * 3));
});

test("customer: the button, the hold and the settled charge are one figure, in credits", () => {
  const usd = estimateImageCostUsd(NB2, model.resolutions[0], 0)!.net;
  const credits = quoteWorkbenchMedia(model, { resolution: model.resolutions[0], ratio: model.ratios[0], duration: 0 }, NO_REFERENCES).credits!;
  const button = priceDisplay(makeQuote(exact(credits), { dollars: false, creditUsd: creditUsd() }), undefined, ENV(false))!.text;
  const held = renderState(at({ price: { amount: credits, unit: "cr" } }), 70_000).money!.text;
  expect(button).toBe(`${credits} cr`);
  expect(held).toBe(`${credits} cr held · charged only when it’s ready`);
  expect(fmtRenderPrice({ amount: credits, unit: "cr" })).toBe(button);
  /* The dollars sent for a customer's quote can never alter what they are shown. */
  expect(priceDisplay(makeQuote(exact(credits), { dollars: false, creditUsd: creditUsd() }, usd), undefined, ENV(false))!.text).toBe(button);
  /* Cancel sent: the figure stands alone, with no promise beside it (see RenderMoney). */
  expect(renderState(at({ price: { amount: credits, unit: "cr" } }), 70_000).money!.short).toBe(`${credits} cr held`);
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

test("a take in flight says on its Make tile, under its held figure, that it is charged only when it's ready (or what the engine reports); a cancel on its way drops the promise", async () => {
  const { tileTail } = await import("../../lib/v12/make");
  const running = renderState(at({ price: { amount: 0.045, unit: "usd" } }), 70_000);
  expect(running.tile).toBe("Rendering · 1:10 so far · $0.05 held");
  expect(tileTail(running)).toBe("Charged only when it’s ready");
  expect(tileTail(renderState(at({ price: { amount: 1, unit: "cr" } }), 70_000))).toBe("Charged only when it’s ready");
  /* Slow, preparing, failed and waiting takes carry their own words, not this. */
  expect(tileTail(renderState(at({ price: { amount: 1, unit: "cr" } }), 40 * 60_000))).toBeNull();
  expect(tileTail(renderState(at({ status: "queued", price: { amount: 1, unit: "cr" } }), 70_000))).toBeNull();
  expect(tileTail(renderState(at({ status: "failed" }), 70_000))).toBeNull();
  /* Cinema Studio holds a band over its quote: its own words. */
  expect(tileTail(renderState(at({ model: "higgsfield-cinema-studio-4.0", provider: "higgsfield", price: { amount: 129, unit: "cr" } }), 70_000))).toBe("Charged what the engine reports");
});

test("the house is never shown the customer price in dollars: with no engine dollars it shows no figure, with them it says it pays at cost", () => {
  const env = { creditUsd: creditUsd(), dollars: fmtLedgerUsd };
  /* No dollars in the answer (an enhancement added, a price that moved): "—" with its reason, never credits turned into dollars. */
  const none = priceDisplay(makeQuote(exact(1), { dollars: true, creditUsd: creditUsd() }), undefined, env)!;
  expect(none).toMatchObject({ text: "—", title: NO_AT_COST_PRICE, state: "error" });
  expect(none.text).not.toMatch(/\d/);
  /* An estimate (sound) keeps its "up to", in dollars. */
  expect(priceDisplay(makeQuote({ kind: "up-to", credits: 2 } as never, { dollars: true, creditUsd: creditUsd() }, 0.1234), undefined, env)!.text).toBe("up to $0.13");
  /* The hover says so. */
  const dollars = priceDisplay(makeQuote(exact(1), { dollars: true, creditUsd: creditUsd() }, 0.045), undefined, env)!;
  expect([dollars.text, dollars.title]).toEqual(["$0.05", PAYS_AT_COST]);
  expect(PAYS_AT_COST).toBe("Pays at cost");
});

test("Cinema Studio for the house: about and at most, in the engine's dollars; the customer's words stay credits", async () => {
  const { houseAbout } = await import("../../lib/v12/make");
  expect(houseAbout(0.42)).toBe("about $0.42, at most $1.26");
});

test("a cancel on its way: the money line keeps its figure and says it settles when the engine confirms; otherwise it keeps both", () => {
  const state = renderState(at({ price: { amount: 0.045, unit: "usd" } }), 70_000);
  expect(moneyLine(state.money!)).toEqual({ head: "$0.05 held", tail: " · charged only when it’s ready" });
  expect(moneyLine(state.money!, true)).toEqual({ head: "$0.05 held", tail: " · settles when the engine confirms" });
  expect(moneyLine(state.money!, true).head + moneyLine(state.money!, true).tail).not.toMatch(/charged only when/);
});

test("Atomik's thinking (Home Start, the new-board bar, the board bar): the house reads the planner's dollars or no figure; a customer reads credits", async () => {
  const { planningQuote } = await import("../../lib/v12/quote");
  const { thinkingFrom } = await import("../../lib/shell/thinking-price");
  const env = { creditUsd: creditUsd(), dollars: fmtLedgerUsd };
  const body = { agent: { enabled: true, ask: { planning: 4, planningUsd: 0.373 } } };
  expect(thinkingFrom(body)).toEqual({ state: "ready", credits: 4, usd: 0.373 });
  /* A credit workspace is never sent the dollars, and never reads them. */
  expect(thinkingFrom({ agent: { enabled: true, ask: { planning: 4 } } })).toEqual({ state: "ready", credits: 4 });
  const credits = priceDisplay(planningQuote({ kind: "up-to", credits: 4 }, 0.373, false), undefined, env)!;
  expect(credits.text).toBe("up to 4 cr");
  const house = priceDisplay(planningQuote({ kind: "up-to", credits: 4 }, 0.373, true), undefined, env)!;
  expect([house.text, house.title]).toEqual(["up to $0.38", PAYS_AT_COST]);
  expect(priceDisplay(planningQuote({ kind: "up-to", credits: 4 }, null, true), undefined, env)).toMatchObject({ text: "—", title: NO_AT_COST_PRICE });
  /* The press still approves the credits: the dollars change what is shown, not the limit. */
  expect(thinkingFrom(body)).toMatchObject({ credits: 4 });
});

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

test("a cancel on its way with no figure on the take reads only what is true", () => {
  const unpriced = renderState(at({}), 70_000).money!;
  expect(moneyLine(unpriced, true)).toEqual({ head: "Settles when the engine confirms", tail: "" });
});
