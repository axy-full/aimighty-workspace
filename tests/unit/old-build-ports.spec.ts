import { test, expect } from "@playwright/test";
import { MODELS } from "../../lib/models";

/**
 * The money, sign-in and tenancy assertions of the prototype-12 build's unit specs (tests/unit/v12-*.spec.ts, v25-*.spec.ts, rig-model),
 * deleted with that build (owner, 23 Oct 2026; docs/old-shells.md). Where an assertion tested live code, it is here as it was; where it
 * tested the deleted build's own logic, it is a fixme with its reason and the owner's question, so nothing is dropped unseen.
 */

/* ── Live code, kept as it was ──────────────────────────────────────────────────────────────────────────────────────── */

test.describe("v12-make › Reuse seed: the seed rides in the priced request", () => {
  const seeded = MODELS.filter((m) => !m.retired && m.kind === "video");
  test("a clip's request carries the seed when one is set; a still's, or none, carries no seed; the quote and the send carry the same seed", async () => {
    const { generationRequestBody } = await import("../../lib/workbench/generation-request");
    const { takesSeed } = await import("../../lib/workspace/composer");
    const engine = seeded.find((m) => takesSeed(m.id));
    expect(engine, "an offered engine takes a seed").toBeTruthy();
    const request = { prompt: "a wave", kind: "video" as const, model: { id: engine!.id }, mapping: { shotId: "s", productionProjectId: "p" }, ratio: "16:9", resolution: "1080p", duration: 5, references: [] };
    expect(generationRequestBody({ ...request, seed: 8841 })).toMatchObject({ seed: 8841, model: engine!.id });
    expect(generationRequestBody({ ...request, seed: 0 })).toMatchObject({ seed: 0 });
    for (const seed of [undefined, null, Number.NaN])
      expect(generationRequestBody({ ...request, seed }), String(seed)).not.toHaveProperty("seed");
    expect(generationRequestBody({ ...request, kind: "image", seed: 8841 })).not.toHaveProperty("seed");
    /* The quote and the send are built from the same input, so the fingerprint the press approves covers the seed. */
    const quoted = generationRequestBody({ ...request, seed: 8841 });
    const sent = generationRequestBody({ ...request, seed: 8841, maxCredits: 43, quoteFingerprint: "f" });
    expect(sent.seed).toBe(quoted.seed);
  });

  test("only an engine that passes a seed on takes one: no still engine, and nothing that is not an engine", async () => {
    const { takesSeed } = await import("../../lib/workspace/composer");
    expect(MODELS.some((m) => takesSeed(m.id))).toBe(true);
    for (const m of MODELS.filter((m) => m.kind === "image")) expect(takesSeed(m.id), m.id).toBe(false);
    for (const id of ["nope", "", null, undefined]) expect(takesSeed(id), String(id)).toBe(false);
  });

  test("a batch with one seed repeats it on take 1 and varies the others, always a seed the server accepts", async () => {
    const { variationSeed } = await import("../../lib/workspace/composer");
    expect(variationSeed(8841, 1)).toBe(8841);
    expect([1, 2, 3, 4].map((v) => variationSeed(8841, v))).toEqual([8841, 8842, 8843, 8844]);
    for (const seed of [0, 2_147_483_647, 4_294_967_295]) for (const v of [1, 2, 3, 4]) {
      const out = variationSeed(seed, v);
      expect(Number.isInteger(out) && out >= 0 && out <= 4_294_967_295, `${seed}/${v}`).toBe(true);
    }
    expect(variationSeed(4_294_967_295, 1)).toBe(4_294_967_295);
  });

  test("the price's key covers the seed that is sent, and is unchanged without one", async () => {
    const { quoteKeyFor, takesSeed } = await import("../../lib/workspace/composer");
    const engine = seeded.find((m) => takesSeed(m.id))!;
    const base = { type: "video" as const, modelId: engine.id, settings: { ratio: "16:9", resolution: "1080p", duration: 5 } as never, references: [], prompt: "", seconds: 0, instrumental: false, voiceId: "" };
    expect(quoteKeyFor({ ...base, seed: null })).toBe(quoteKeyFor(base));
    expect(quoteKeyFor({ ...base, seed: 8841 })).not.toBe(quoteKeyFor(base));
    expect(quoteKeyFor({ ...base, seed: 8841 })).not.toBe(quoteKeyFor({ ...base, seed: 8842 }));
  });
});

test("v12-enhance-house › the enhancer's quote carries its dollars to the house alone", async () => {
  const { atomikPublicResponse } = await import("../../lib/workbench/atomik-response");
  const quote = { model: "m", effort: "auto", estimateCredits: 1, estimateUsd: 0.0123 };
  expect(atomikPublicResponse(quote, false)).toEqual(quote);
  expect(atomikPublicResponse(quote, true)).toEqual({ model: "m", effort: "auto", estimateCredits: 1 });
});

test("v12-join-model › the access request's note: Guest Home's as before, plus company, role and size; the honeypot is never read; it is capped", async () => {
  const { accessRequestNote } = await import("../../lib/accessRequestNote");
  expect(accessRequestNote({ note: "From guest Home", make: "Ad films", brief: "A brief" })).toBe("From guest Home\nWhat they make: Ad films\nTheir brief: A brief");
  expect(accessRequestNote({})).toBe("");
  expect(accessRequestNote({ note: "From the join sheet (start)", organisation: "North", role: "Agency", size: "11–50", brief: "A 15 s ad" }))
    .toBe("From the join sheet (start)\nCompany: North\nRole: Agency\nCompany size: 11–50\nTheir brief: A 15 s ad");
  expect(accessRequestNote({ company: "bot" })).toBe("");
  expect(accessRequestNote({ brief: "x".repeat(5000) }).length).toBeLessThanOrEqual(1200);
});

/* ── The deleted build's own logic: no home until v31.16 draws these surfaces ───────────────────────────────────────── */

const ASK = "owner question: does v31.16 carry this rule, or is it dropped?";
const fixme = (spec: string, what: string, live?: string) =>
  test.fixme(`${spec} › ${what} — no home: the prototype-12 code it tested is deleted (23 Oct 2026)${live ? `; live: ${live}` : ""}; ${ASK}`, () => {});

fixme("v12-price", "every price reads N cr, up to N cr, free, or quoted with a reason; no number while loading or on error; the house reads dollars with Pays at cost and never cr; each source asks its quote route and reserves nothing", "lib/shell/price-words.ts (tests/unit/houseDollars.spec.ts)");
fixme("v12-billing", "the cycle's dates, the history's charged and held rows (nothing for a free job), spend per board (credits only), the plan now, the plan cards from lib/plans, and the house's per-board and ledger dollars from the summary only");
fixme("v12-low-credit", "low below 20% of the cycle's included credits (the welcome grant on Invite, the pooled base on Business); never for the house; never without a balance");
fixme("v12-render-state / v12-render-take / v12-render-cancel", "held for credits with nothing charged; \"nothing billed\" only when the ledger settled at nothing (a dollar workspace needs the provider's word); a Retry figure only from a fresh quote; Cancel only for the take's author, an admin or the owner, and only where nothing is billed; a refused or lost cancel never says nothing billed; the facts a row carries hold no id, handle, lease or figure", "TakeCard's failed line (tests/old-build-ports-workbench.spec.ts); the cancel route (tests/queued-cancel-workbench.spec.ts)");
fixme("v12-header-model", "\"held\" only for the ledger's reservation; a queued take holds nothing");
fixme("v12-home", "Home's Start figure from the planner, in one unit, the house at the planner's dollars, the sample workspace with none", "components/graphite/home (tests/demo-s02-waiting-workbench.spec.ts)");
fixme("v12-make", "Make's price in the workspace's unit: credits as the server gave them, the house at the engine's dollars and never credits times a credit's price");
fixme("v12-enhance-house", "the house's button is the take's dollars plus the enhancement's, \"up to\", Pays at cost; its enhancement counts at no credits; no house figure without both dollar figures; a credit workspace unchanged");
fixme("v12-enhance", "the Enhance choice is kept per workspace and person; the admin's default sets where it starts");
fixme("v12-menus", "no price is written into a menu; Redraw's price comes from recreateQuote");
fixme("v12-skills", "a saved skill's price is its preview's estimates summed, \"up to\"; the preview cache is per workspace scope (tenancy)", "tests/demo-s08-skills-workbench.spec.ts (dry runs)");
fixme("v12-social / v12-campaign / v12-deliver", "every stage quote carries quoteOnly, nothing is priced without its inputs, a format's price is a quote request or a reason, and nothing no route quotes is priced");
fixme("v12-board-stages / v12-rounds", "a stage's primary never spends; a client round's Approve all is the plan's own price, and a customer's plan card never reads as a round", "the plan card's approval (tests/demo-s04-plan-workbench.spec.ts)");
fixme("v12-typical-times", "the typical times' shared pool is fair across workspaces and only a number comes back (tenancy); a workspace's own history is told from the platform's");
fixme("v12-join-model / v12-join-return / v12-visitor", "join titles; the request body never fills the honeypot; invite kinds and the open-redirect guard (loginPath of another site is /login?next=%2F); where to return after joining; the showcase is public stills and never a workspace's (tenancy); an invite's title and banner, and signupPath carries only the typed name", "Guest Home and sign-up (tests/demo-s15-guest-home-workbench.spec.ts, tests/unit/authPages.spec.ts)");
fixme("v25-director-model", "a multi-shot press is one job at the quote's total as its ceiling (the house at a credit's public price), Retry at the approval as a ceiling, \"Nothing billed\" only when the ledger settled at nothing, at most 24 shots, the approval good for 7 days, its claim kept across a lost reply", "the press itself, server side: tests/unit/batchPress.spec.ts (no live screen presses a batch)");
fixme("rig-model", "the Rig's change price is ready only when every read is back; a step says Nothing billed only when confirmed");
