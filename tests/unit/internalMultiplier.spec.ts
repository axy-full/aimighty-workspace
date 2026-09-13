import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { multiplierFor, billCreditsWith, marginFor, creditUsd, tableFor, DEFAULT_MARGINS, INTERNAL_MARGINS } from "../../lib/creditTerms";
import { quoteOf, liveTerms, stampOf } from "../../lib/quote";

/**
 * §7A guardrail 6: a workspace flagged internal bills at cost — multiplier
 * 1.0, the same rounding, the same ledger — and a normal one is unchanged.
 * Every pricing site reads the one rule, so the button and the ledger agree.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-internal-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";

const workspace = (over: Record<string, unknown>) => ({
  id: "ws_im_normal", slug: "im-normal", name: "Unit", legacy: false, dbUrl: process.env.TURSO_DATABASE_URL, dbToken: null,
  keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_unit", createdAt: 0, ...over,
});

const SEEDANCE = "dreamina-seedance-2-5-260628";
const COST = 2.864;
const atCost = Math.ceil(COST / creditUsd() - 1e-9); // 29
const atMargin = Math.ceil((COST * 1.5) / creditUsd() - 1e-9); // 43

test("multiplierFor is 1 for an internal workspace and the engine's margin otherwise", () => {
  expect(multiplierFor(SEEDANCE, true)).toBe(1);
  expect(multiplierFor("anything", true)).toBe(1);
  expect(multiplierFor(SEEDANCE, false)).toBe(marginFor(SEEDANCE));
  expect(multiplierFor(null, false)).toBe(DEFAULT_MARGINS["*"]);
  expect(tableFor(true)).toEqual(INTERNAL_MARGINS);
  expect(tableFor(false)["*"]).toBe(marginFor("*"));
});

test("an internal workspace's quote is ceil(cost / creditUsd) with no margin; a normal one is unchanged", () => {
  const units = [{ key: "a", usd: COST, engine: SEEDANCE }];
  expect(quoteOf(units, liveTerms(true)).totalCredits).toBe(atCost);
  expect(quoteOf(units, liveTerms(false)).totalCredits).toBe(atMargin);
  expect(quoteOf(units).totalCredits).toBe(atMargin);
  expect(quoteOf(units, liveTerms(true)).totalCredits).toBe(billCreditsWith(COST, 1, creditUsd()));
  /* The stamp carries the table, so an internal quote never reads as fresh against a normal one. */
  expect(stampOf(units, liveTerms(true))).not.toBe(stampOf(units, liveTerms(false)));
});

test("the meter bills an internal workspace at cost and a normal one at the margin", async () => {
  const { meter, creditsUsed } = await import("../../lib/meter");
  const { runInTenant } = await import("../../lib/tenant");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normal = workspace({}) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = workspace({ id: "ws_im_internal", slug: "im-internal", internal: true }) as any;
  await runInTenant(normal, () => meter({ id: "gen_im_normal", kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: COST }));
  await runInTenant(internal, () => meter({ id: "gen_im_internal", kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: COST }));
  expect(await creditsUsed("ws_im_normal")).toBe(atMargin);
  expect(await creditsUsed("ws_im_internal")).toBe(atCost);
  /* The completion keeps the workspace's multiplier: the actual cost is re-billed at 1.0. */
  await runInTenant(internal, () => meter({ id: "gen_im_internal", kind: "video", engine: "byteplus", model: SEEDANCE, status: "succeeded", engineCostUsd: 3.0 }));
  expect(await creditsUsed("ws_im_internal")).toBe(30);
});

test("the rate table, the held snapshot and the SQL sum follow the same flag", async () => {
  const { buildRateTable } = await import("../../lib/rateTable.server");
  const { heldInfo } = await import("../../lib/held");
  const { billedCreditsExpr } = await import("../../lib/creditSql");
  const { runInTenant } = await import("../../lib/tenant");
  const normal = buildRateTable("cr", false);
  const internal = buildRateTable("cr", true);
  const nt = normal.models[SEEDANCE].tiers?.[0]; const it = internal.models[SEEDANCE].tiers?.[0];
  expect(nt && it).toBeTruthy();
  expect(it!.withoutVideo * 1.5).toBeCloseTo(nt!.withoutVideo, 9);
  expect(buildRateTable("usd", true).models[SEEDANCE].tiers?.[0].withoutVideo).toBeCloseTo(buildRateTable("usd", false).models[SEEDANCE].tiers?.[0].withoutVideo ?? -1, 9);
  expect(heldInfo(COST, "video", SEEDANCE, "credits", true).needs).toBe(atCost);
  expect(heldInfo(COST, "video", SEEDANCE, "credits", false).needs).toBe(atMargin);
  expect(billedCreditsExpr("", true)).toContain("ELSE 1 END");
  expect(billedCreditsExpr("", false)).toContain("ELSE 1.5 END");
  /* Defaulted from the tenant in scope, so the nine callers that inline it need not know. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = workspace({ id: "ws_im_i2", slug: "im-i2", internal: true }) as any;
  await runInTenant(ws, async () => {
    expect(billedCreditsExpr()).toContain("ELSE 1 END");
    expect(heldInfo(COST, "video", SEEDANCE).needs).toBe(atCost);
    expect(buildRateTable("cr").models[SEEDANCE].tiers?.[0].withoutVideo).toBeCloseTo(it!.withoutVideo, 9);
  });
});

test("a recipe's prices, the cap's needs, the balance's need and the preview batch follow the same flag", async () => {
  const { stagePrice, unitCreditsFor, unitUsdFor, floorCreditsOf } = await import("../../lib/runs");
  const { capNeeds } = await import("../../lib/caps");
  const { creditNeed } = await import("../../lib/credits");
  const { previewPlan } = await import("../../lib/previewCost");
  const { runInTenant } = await import("../../lib/tenant");
  const per = creditUsd();

  /* A stage: one unit at cost is ceil(usd / creditUsd) with no margin; a batch multiplies before it rounds, at 1.0. */
  expect(stagePrice(COST, 1, SEEDANCE, true)).toBe(atCost);
  expect(stagePrice(COST, 1, SEEDANCE, false)).toBe(atMargin);
  expect(stagePrice(COST, 1, SEEDANCE)).toBe(atMargin);
  expect(stagePrice(COST, 3, SEEDANCE, true)).toBe(Math.ceil((COST * 3) / per - 1e-9));
  expect(stagePrice(COST, 3, SEEDANCE, false)).toBe(Math.ceil((COST * 3 * 1.5) / per - 1e-9));

  /* A unit off the rate table: the internal figure is ceil(usd / creditUsd) of the same vendor figure. */
  const unitUsd = unitUsdFor(SEEDANCE, "render");
  expect(unitUsd).not.toBeNull();
  expect(unitCreditsFor(SEEDANCE, "render", null, true)).toBe(Math.ceil((unitUsd as number) / per - 1e-9));
  expect(unitCreditsFor(SEEDANCE, "render", null, false)).toBe(Math.ceil(((unitUsd as number) * 1.5) / per - 1e-9));
  expect(unitCreditsFor(SEEDANCE, "render")).toBe(unitCreditsFor(SEEDANCE, "render", null, false));
  expect(unitCreditsFor("nope", "render", null, true)).toBeNull();

  /* The cap's needs and the balance's need: the same arithmetic, in credits; dollars pass through untouched. */
  expect(capNeeds(COST, "cr", SEEDANCE, true)).toBe(atCost);
  expect(capNeeds(COST, "cr", SEEDANCE, false)).toBe(atMargin);
  expect(capNeeds(COST, "$", SEEDANCE, true)).toBe(COST);
  expect(capNeeds(COST, "$", SEEDANCE, false)).toBe(COST);
  expect(creditNeed(COST, SEEDANCE, true)).toBe(atCost);
  expect(creditNeed(COST, SEEDANCE, false)).toBe(atMargin);
  expect(creditNeed(COST, SEEDANCE, true)).toBe(billCreditsWith(COST, 1, per));

  /* The preview batch, at the multiplier of the workspace that renders it. */
  const pi = previewPlan("dreamina-seedance-2-0-260128", "480p", 3, true);
  const pn = previewPlan("dreamina-seedance-2-0-260128", "480p", 3, false);
  expect(pi.perClipUsd).toBeGreaterThan(0);
  expect(pi.perClipUsd).toBe(pn.perClipUsd);
  expect(pi.perClipCredits).toBe(Math.ceil(pi.perClipUsd / per - 1e-9));
  expect(pn.perClipCredits).toBe(Math.ceil((pn.perClipUsd * 1.5) / per - 1e-9));
  expect(pi.totalCredits).toBe(pi.perClipCredits * pi.count);
  expect(previewPlan("dreamina-seedance-2-0-260128", "480p", 3).perClipCredits).toBe(pn.perClipCredits);

  /* Defaulted from the tenant in scope, so the recipe editor, the walls and the console need not know. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = workspace({ id: "ws_im_i3", slug: "im-i3", internal: true }) as any;
  await runInTenant(ws, async () => {
    expect(stagePrice(COST, 1, SEEDANCE)).toBe(atCost);
    expect(stagePrice(COST, 1, SEEDANCE, false)).toBe(atMargin);
    expect(unitCreditsFor(SEEDANCE, "render")).toBe(Math.ceil((unitUsd as number) / per - 1e-9));
    expect(previewPlan("dreamina-seedance-2-0-260128", "480p", 3).perClipCredits).toBe(pi.perClipCredits);
    /* A credit workspace's figure is already credits: the floor reads it as it is. */
    expect(floorCreditsOf(atCost, SEEDANCE)).toBe(atCost);
  });
  /* A dollar workspace (its own keys) that is also internal: its vendor dollars reach the floor at cost. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dollar = workspace({ id: "ws_im_d", slug: "im-d", usesPlatformKeys: false, internal: true }) as any;
  await runInTenant(dollar, async () => {
    expect(floorCreditsOf(COST, SEEDANCE)).toBe(atCost);
    expect(floorCreditsOf(COST, SEEDANCE, false)).toBe(atMargin);
    expect(stagePrice(COST, 1, SEEDANCE)).toBe(Math.round(COST * 100) / 100);
  });
});
