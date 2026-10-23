import { test, expect } from "@playwright/test";
import { MODELS } from "../../lib/models";

/**
 * The money, sign-in and tenancy assertions of the prototype-12 build's unit specs (tests/unit/v12-*.spec.ts, v25-*.spec.ts, rig-model),
 * deleted with that build (owner, 23 Oct 2026; docs/old-shells.md). Where an assertion tested live code, it is here as it was (only the
 * lines that called deleted code are left out); where it
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

/* v12-enhance-house, tests 1–4: the live goFigure (lib/shell/make-price.ts), Make's button total (components/graphite/make/use-make.ts). The
   priceDisplay and makeQuote lines went with the deleted price layer; their dollar wording is tests/unit/houseDollars.spec.ts. */
test.describe("v12-enhance-house › Make's one total in the house, at cost (goFigure)", () => {
  const base = { total: 7, count: 1, type: "image" as const, batchRequoted: false };

  test("the button is the take's dollars plus the enhancement's, one total, 'up to'", async () => {
    const { goFigure } = await import("../../lib/shell/make-price");
    const fig = goFigure({ ...base, takeUsd: 0.4, enhanceCredits: 1, enhanceUsd: 0.0123 });
    expect(fig.usd).toBeCloseTo(0.4123, 6);
    expect(fig.value?.kind).toBe("up-to");
    /* Several takes: the take's dollars are per take; the enhancement is written once. */
    expect(goFigure({ ...base, count: 3, total: 21, takeUsd: 0.4, enhanceCredits: 1, enhanceUsd: 0.01 }).usd).toBeCloseTo(1.21, 6);
  });

  test("the house's enhancement counts even when it is 0 credits: nothing is billed in credits there, the dollars are the cost", async () => {
    const { goFigure } = await import("../../lib/shell/make-price");
    const fig = goFigure({ ...base, takeUsd: 0.4, enhanceCredits: 0, enhanceUsd: 0.02 });
    expect(fig.usd).toBeCloseTo(0.42, 6);
    expect(fig.value?.kind).toBe("up-to");
  });

  test("without both figures in dollars the house has no figure: never the customer price turned into dollars", async () => {
    const { goFigure } = await import("../../lib/shell/make-price");
    for (const o of [{ takeUsd: null, enhanceUsd: 0.01 }, { takeUsd: 0.4, enhanceUsd: null }]) {
      const fig = goFigure({ ...base, enhanceCredits: 1, ...o });
      expect(fig.usd).toBeNull();
    }
    /* A batch quoted take by take has no single dollar figure either. */
    expect(goFigure({ ...base, takeUsd: 0.4, batchRequoted: true, enhanceCredits: 1, enhanceUsd: 0.01 }).usd).toBeNull();
  });

  test("a credit workspace is unchanged: credits of both, exact, no dollars", async () => {
    const { goFigure } = await import("../../lib/shell/make-price");
    const fig = goFigure({ ...base, takeUsd: null, enhanceCredits: 1, enhanceUsd: null });
    expect(fig).toMatchObject({ usd: null, value: { kind: "exact", credits: 8 } });
    expect(goFigure({ ...base, takeUsd: null, enhanceCredits: null, enhanceUsd: null })).toMatchObject({ usd: null, value: { kind: "exact", credits: 7 } });
    /* With Enhance off (no enhancement) the house's take is its own dollars alone, exact. */
    expect(goFigure({ ...base, takeUsd: 0.4, enhanceCredits: null, enhanceUsd: null })).toMatchObject({ usd: 0.4, value: { kind: "exact" } });
  });
});

/* v12-home, "Start's figure: shown equals approved": the live startFigure and startFigureUsd (components/graphite/home/home-model.ts), which
   Home's Start shows and approves (use-home-start.ts). The startQuote lines went with the deleted lib/v12/home.ts. */
test.describe("v12-home › Start's figure: shown equals approved", () => {
  const ready = { state: "ready", credits: 9 };
  test("the planner's figure for a new board, or the newer one the server gave for the same words", async () => {
    const { startFigure } = await import("../../components/graphite/home/home-model");
    expect(startFigure(null, ready, "a film")).toBe(9);
    /* After "Press Start again to approve it": the higher figure, for those words only. */
    expect(startFigure({ text: "a film", figure: 14 }, ready, "a film")).toBe(14);
    expect(startFigure({ text: "a film", figure: 14 }, ready, "another film")).toBe(9);
    expect(startFigure({ text: "a film", figure: null }, ready, "a film")).toBe(9);
    expect(startFigure(null, { state: "loading" }, "a film")).toBeNull();
    expect(startFigure({ text: "a film", figure: 14 }, { state: "error" }, "a film")).toBe(14);
  });

  test("the house workspace sees the planner's own dollars, the newer figure's own when there is one, and none when that has none", async () => {
    const { startFigure, startFigureUsd } = await import("../../components/graphite/home/home-model");
    const started = { text: "w", figure: 20, usd: 0.52 };
    expect(startFigure(started, ready, "w")).toBe(20);
    expect(startFigureUsd(started, { state: "ready", usd: 0.37 }, "w")).toBe(0.52);
    expect(startFigureUsd(null, { state: "ready", usd: 0.37 }, "w")).toBe(0.37);
    /* No dollars with the newer figure: no figure, never the credits turned into dollars. */
    expect(startFigureUsd({ text: "w", figure: 20 }, { state: "ready", usd: 0.37 }, "w")).toBeNull();
  });
});

/* v12-enhance: the live request-body, recipe and setting rules behind Make's Enhance (the deleted switch's own rules are fixmes below). */
test.describe("v12-enhance › the live rules", () => {
  test("the workspace's Enhance default is On unless an admin set it Off, and its setting is a closed choice", async () => {
    const { DEFAULTS } = await import("../../lib/settings");
    const { ENHANCE_DEFAULT_OPTIONS, settingProblem } = await import("../../lib/settingValues");
    expect(DEFAULTS.enhanceDefault).toBe("on");
    expect(ENHANCE_DEFAULT_OPTIONS.map(([id]) => id)).toEqual(["on", "off"]);
    expect(settingProblem("enhanceDefault", "on")).toBeNull();
    expect(settingProblem("enhanceDefault", "off")).toBeNull();
    expect(settingProblem("enhanceDefault", "sometimes")).toMatch(/on or off/);
  });

  test("the request carries the label and nothing else changes with it", async () => {
    const { generationRequestBody } = await import("../../lib/workbench/generation-request");
    const base = { prompt: "words", kind: "image" as const, model: { id: "m" }, mapping: { productionProjectId: "p" }, ratio: "16:9", resolution: "1K", duration: 5, references: [], maxCredits: 7 };
    const plain = generationRequestBody(base);
    expect("enhanced" in plain).toBe(false);
    expect(generationRequestBody({ ...base, enhanced: false })).toEqual({ ...plain, enhanced: false });
    expect(generationRequestBody({ ...base, enhanced: { from: "typed" } })).toEqual({ ...plain, enhanced: { from: "typed" } });
  });

  test("Reuse of an Enhanced take marks the loaded words as already enhanced, and any other take does not", async () => {
    const { recreatePreset } = await import("../../lib/shell/recipe");
    const take = (params: Record<string, unknown>) => ({ id: "gen_1", kind: "image", model: "m", prompt: "A paper kite drifts over a grey sea, low sun.", params: { ratio: "16:9", resolution: "1K", ...params } }) as never;
    expect(recreatePreset(take({ enhanced: true, enhancedFrom: "a kite over the sea" }), { name: "x" }).enhancedFrom).toBe("a kite over the sea");
    expect(recreatePreset(take({ enhanced: false, enhancedFrom: "a kite over the sea" }), { name: "x" }).enhancedFrom).toBeUndefined();
    expect(recreatePreset(take({}), { name: "x" }).enhancedFrom).toBeUndefined();
    expect(recreatePreset(take({ enhanced: true }), { name: "x" }).enhancedFrom).toBeUndefined();
  });
});

/* v12-board-stages, v12-deliver, v12-rounds: the draft fields that stay in lib/workbench/studio-schema.ts take what they should and refuse
   nonsense. Literal lists stand in for the deleted stage helpers. */
test.describe("the draft's board fields: the project schema takes them and refuses nonsense", () => {
  const load = async () => ({ ...(await import("../../lib/workbench/studio-schema")), ...(await import("../../lib/workbench/studio")) });

  test("v12-board-stages › boardFlavor: the five kinds, nothing else", async () => {
    const { projectSchema, newProject } = await load();
    for (const flavor of ["film", "previs", "campaign", "narrated", "clips"]) expect(projectSchema.safeParse({ ...newProject("Board"), boardFlavor: flavor }).success, flavor).toBe(true);
    expect(projectSchema.safeParse({ ...newProject("Board"), boardFlavor: "documentary" }).success).toBe(false);
  });

  test("v12-board-stages › boardStages: ids by the pattern, no extra keys, at most 24 on the rail", async () => {
    const { projectSchema, newProject } = await load();
    const project = { ...newProject("Board"), boardStages: [{ id: "brief" }, { id: "edit", label: "Final cut" }, { id: "pitch", skipped: true }, { id: "locations", removed: true }] };
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "bad id!" }] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "brief", colour: "red" }] }).success).toBe(false);
    /* A removed flag is only for the kind's own stages. */
    expect(projectSchema.safeParse({ ...project, boardStages: [{ id: "x1", custom: true, removed: true }] }).success).toBe(false);
    const rail = Array.from({ length: 24 }, (_, i) => ({ id: `s${i}`, label: `Stage ${i}`, custom: true }));
    expect(projectSchema.safeParse({ ...project, boardStages: rail }).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, boardStages: [...rail, { id: "custom-extra", label: "More", custom: true }] }).success).toBe(false);
  });

  test("v12-deliver › boardLanguages: at most twelve, codes only; boardShotList: ids by the pattern, no extra keys, cells of at most 200", async () => {
    const { projectSchema, newProject } = await load();
    const codes = ["en", "es", "fr", "de", "it", "pt", "pl", "nl", "sv", "da", "fi", "no", "cs"];
    expect(projectSchema.safeParse({ ...newProject("B"), boardLanguages: codes }).success).toBe(false);
    expect(projectSchema.safeParse({ ...newProject("B"), boardLanguages: codes.slice(0, 12) }).success).toBe(true);
    const project = { ...newProject("B"), boardShotList: { "shot-1": { lens: "35 mm", move: "" } }, boardLanguages: ["ta"] };
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, boardShotList: { "shot-1": { colour: "red" } } }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardShotList: { "bad id!": { lens: "x" } } }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardLanguages: ["Tamil"] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardShotList: { "shot-1": { lens: "x".repeat(201) } } }).success).toBe(false);
  });

  test("v12-rounds › boardRounds: from round 2, a before keyed by shot number, no extra keys", async () => {
    const { projectSchema, newProject } = await load();
    const round = { n: 2, runId: "run-1", at: 1, changes: [{ shot: 2, text: "Bigger" }], before: { "2": "g2" } };
    const project = { ...newProject("Board"), boardRounds: [round] };
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, boardRounds: [{ ...round, n: 1 }] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardRounds: [{ ...round, before: { x: "g" } }] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardRounds: [{ ...round, extra: true }] }).success).toBe(false);
  });
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
fixme("v12-home", "startQuote: Start's figure worded in one unit (up to N cr, or the house's dollars with a reason when there are none), loading, off and the sample workspace with none", "the figure itself, startFigure and startFigureUsd, is ported above; the words on Home: tests/demo-s02-waiting-workbench.spec.ts");
fixme("v12-make", "Make's price in the workspace's unit: credits as the server gave them, the house at the engine's dollars and never credits times a credit's price");
fixme("v12-enhance-house", "the house's total drawn as \"up to $…\" hovered Pays at cost, and as no figure with its reason when goFigure has no dollars", "goFigure itself is ported above; the live panel does not draw its dollars yet (components/graphite/make/price.tsx:21)");
fixme("v12-enhance", "the Enhance switch's choice is kept per workspace and person and overrides the workspace default; a take says Enhanced or Raw", "the setting, the request label and Reuse are ported above");
fixme("v12-menus", "no price is written into a menu; Redraw's price comes from recreateQuote");
fixme("v12-skills", "a saved skill's price is its preview's estimates summed, \"up to\"; the preview cache is per workspace scope (tenancy)", "tests/demo-s08-skills-workbench.spec.ts (dry runs)");
fixme("v12-social / v12-campaign / v12-deliver", "every stage quote carries quoteOnly, nothing is priced without its inputs, a format's price is a quote request or a reason, and nothing no route quotes is priced");
fixme("v12-board-stages / v12-rounds", "a stage's primary never spends; a client round's Approve all is the plan's own price, and a customer's plan card never reads as a round", "the plan card's approval (tests/demo-s04-plan-workbench.spec.ts); the draft fields' schema refusals are ported above");
fixme("v12-typical-times", "the typical times' shared pool is fair across workspaces and only a number comes back (tenancy); a workspace's own history is told from the platform's");
fixme("v12-join-model / v12-join-return / v12-visitor", "join titles; the request body never fills the honeypot; invite kinds and the open-redirect guard (loginPath of another site is /login?next=%2F); where to return after joining; the showcase is public stills and never a workspace's (tenancy); an invite's title and banner, and signupPath carries only the typed name", "Guest Home and sign-up (tests/demo-s15-guest-home-workbench.spec.ts, tests/unit/authPages.spec.ts)");
fixme("v25-director-model", "a multi-shot press is one job at the quote's total as its ceiling (the house at a credit's public price), Retry at the approval as a ceiling, \"Nothing billed\" only when the ledger settled at nothing, at most 24 shots, the approval good for 7 days, its claim kept across a lost reply", "the press itself, server side: tests/unit/batchPress.spec.ts (no live screen presses a batch)");
fixme("rig-model", "the Rig's change price is ready only when every read is back; a step says Nothing billed only when confirmed");
