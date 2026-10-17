import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Resolution is a visible choice, and the server holds the list (owner, 16 Oct 2026, § D; lib/resolutions.ts).
 *
 * GUARD: the server refuses a resolution the engine does not list, at the quote AND at the press, in words, before anything is priced, held, reserved or sent.
 * Every option the control shows is priced by the quote engine (never a number of ours), native 4K and upscaled 4K are separate options, and an option the engine
 * cannot do is "not on this engine". Nothing here reaches a provider: fetch is forbidden and the engines are mocked.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-resolution-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";

const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
let seq = 0;
/** A credit workspace, or (house) the house workspace, which is never billed in credits and reads its spend at the engines' cost. */
async function inWorkspace<T>(label: string, house: boolean, fn: () => Promise<T>): Promise<T> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  const name = house ? "ws_legacy" : `ws_res_${label}_${++seq}`;
  await platformDb().execute({
    sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  if (!house) await grantCredits(name, 10000, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the resolution test"); };
  try {
    return await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      return fn();
    }, actor);
  } finally {
    globalThis.fetch = fetch;
  }
}
async function traces() {
  const { db } = await import("../../lib/db");
  const { requireTenant } = await import("../../lib/tenant");
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  return {
    generations: Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n),
    meters: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows[0].n),
  };
}
const BODY = { prompt: "A slow push in on a bottle.", projectId: "project", ratio: "16:9", duration: 5, refine: false };

test("every engine's list is the server's: each listed size is accepted in the vendor's own spelling, anything else is refused in words naming the engine and what it makes", async () => {
  const { MODELS } = await import("../../lib/models");
  const { pickResolution, listedResolutions, defaultResolution } = await import("../../lib/resolutions");
  expect(MODELS.length).toBeGreaterThan(20);
  for (const model of MODELS) {
    expect(listedResolutions(model).length, model.id).toBeGreaterThan(0);
    /* Naming none is the engine's default. */
    for (const none of [undefined, null, ""]) expect(pickResolution(model, none), model.id).toEqual({ resolution: defaultResolution(model) });
    for (const listed of model.resolutions) {
      expect(pickResolution(model, listed), `${model.id} ${listed}`).toEqual({ resolution: listed });
      /* Case is not a different size. */
      expect(pickResolution(model, listed.toUpperCase()), `${model.id} ${listed}`).toEqual({ resolution: listed });
    }
    for (const bad of ["8k", "16k", "240p", "1440p", "12345678", 1080, true, {}, ["1080p"]]) {
      if (typeof bad === "string" && model.resolutions.some((r) => r.toLowerCase() === bad)) continue;
      const verdict = pickResolution(model, bad);
      expect("error" in verdict, `${model.id} ${JSON.stringify(bad)}`).toBe(true);
      if ("error" in verdict) {
        expect(verdict.error).toContain(model.label);
        expect(verdict.error).toMatch(/It makes /);
        for (const listed of model.resolutions) expect(verdict.error.toLowerCase(), model.id).toContain(listed.toLowerCase());
        expect(verdict.resolutions).toEqual(model.resolutions);
      }
    }
  }
});

test("GUARD, at the quote and at the press: a size the engine does not list is refused 400 in words, with nothing priced, held, reserved, metered or sent; a listed size is quoted", async () => {
  const { prepareGeneration, executeGenerationAdmission } = await import("../../lib/generationAdmission");
  const { MODELS } = await import("../../lib/models");
  const { RESOLUTION_LADDER } = await import("../../lib/resolutions");
  for (const house of [false, true]) {
    await inWorkspace(house ? "house" : "credits", house, async () => {
      const before = await traces();
      const deferred: unknown[] = [];
      const press = (body: Record<string, unknown>) => executeGenerationAdmission({ ...body, maxCredits: 100000 }, actor, { defer: async (work) => { deferred.push(work); } });
      /* The engines that make video from words, and a still engine: every size on the ladder (and a few that are on none) that the engine does not list. */
      const engines = MODELS.filter((m) => ["dreamina-seedance-2-5-260628", "dreamina-seedance-2-0-260128", "fal-ai/kling-video/v3/standard", "fal-ai/kling-video/v3/pro", "grok-imagine-video", "gemini-3.1-flash-image", "gemini-3-pro-image"].includes(m.id));
      expect(engines).toHaveLength(7);
      let refused = 0;
      for (const model of engines) {
        const unlisted = [...RESOLUTION_LADDER, "512", "1K", "2K", "8k", "100p"].filter((r) => !model.resolutions.some((l) => l.toLowerCase() === r.toLowerCase()));
        expect(unlisted.length, model.id).toBeGreaterThan(0);
        for (const resolution of unlisted) {
          const body = model.kind === "image" ? { prompt: "A bottle on a table.", model: model.id, projectId: "project", resolution } : { ...BODY, model: model.id, resolution };
          const quote = await prepareGeneration(body, actor);
          expect(quote.ok, `${model.id} ${resolution} quote`).toBe(false);
          if (!quote.ok) {
            expect(quote.status, `${model.id} ${resolution}`).toBe(400);
            expect(String(quote.body.error), `${model.id} ${resolution}`).toContain(`${model.label} does not make`);
            expect(String(quote.body.error), `${model.id} ${resolution}`).toMatch(/It makes /);
            expect(quote.body.resolutions).toEqual(model.resolutions);
          }
          const pressed = await press(body);
          expect(pressed.status, `${model.id} ${resolution} press`).toBe(400);
          expect(String(pressed.body.error), `${model.id} ${resolution}`).toContain(`${model.label} does not make`);
          refused++;
        }
        /* A listed size (and none at all) is quoted, in the unit this workspace pays in. */
        for (const resolution of [model.resolutions[0], model.resolutions.at(-1)!, undefined]) {
          const body = model.kind === "image" ? { prompt: "A bottle on a table.", model: model.id, projectId: "project", resolution } : { ...BODY, model: model.id, resolution };
          const quote = await prepareGeneration(body, actor);
          expect(quote.ok, `${model.id} ${String(resolution)} ${JSON.stringify(quote.ok ? "" : quote.body)}`).toBe(true);
          if (quote.ok) expect(quote.value.quote.unit).toBe(house ? "usd" : "cr");
        }
      }
      expect(refused).toBeGreaterThan(20);
      /* Nothing was written, held or deferred by any refusal. */
      expect(deferred).toEqual([]);
      expect(await traces()).toEqual(before);
      /* The sizes are judged on the server whatever the client sends: a number, a list and a size with the engine's name in it are no size. */
      for (const resolution of [1080, ["1080p"], "1080p; 4k", "Seedance 2.5 1080p"]) {
        const body = { ...BODY, model: "dreamina-seedance-2-5-260628", resolution };
        expect((await prepareGeneration(body, actor)).ok, JSON.stringify(resolution)).toBe(false);
        expect((await press(body)).status, JSON.stringify(resolution)).toBe(400);
      }
      /* 4K upscaled is a plan of two jobs, not a size to send: the press says how to ask for it. */
      const plan = await press({ ...BODY, model: "dreamina-seedance-2-5-260628", resolution: "4k-upscaled" });
      expect(plan.status).toBe(400);
      expect(String(plan.body.error)).toMatch(/render and then an upscale, two steps/);
      expect(await traces()).toEqual(before);
    });
  }
});

test("native 4K needs an engine that lists it; where there is none the refusal says so and points to the upscale, and a draft stays 480p", async () => {
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  await inWorkspace("fourk", false, async () => {
    const seedance = await prepareGeneration({ ...BODY, model: "dreamina-seedance-2-5-260628", resolution: "4k" }, actor);
    expect(seedance.ok).toBe(false);
    if (!seedance.ok) expect(String(seedance.body.error)).toBe("Seedance 2.5 does not make 4K natively. It makes 480p, 720p, 1080p. For 4K, make it at 1080p and upscale it.");
    const kling = await prepareGeneration({ ...BODY, model: "fal-ai/kling-video/v3/standard", resolution: "720p" }, actor);
    expect(kling.ok).toBe(false);
    if (!kling.ok) expect(String(kling.body.error)).toBe("Kling 3.0 does not make 720p. It makes 1080p.");
    /* Seedance 2.0 lists a 4K (untested here): that is a native option the engine itself lists. */
    expect((await prepareGeneration({ ...BODY, model: "dreamina-seedance-2-0-260128", resolution: "4K" }, actor)).ok).toBe(true);
    /* A draft is its own fixed size; asking for another is refused as it always was. */
    const draft = await prepareGeneration({ ...BODY, model: "dreamina-seedance-2-5-260628", draft: true, resolution: "1080p" }, actor);
    expect(draft.ok).toBe(false);
    if (!draft.ok) expect(String(draft.body.error)).toBe("A draft renders at 480p.");
    expect((await prepareGeneration({ ...BODY, model: "dreamina-seedance-2-5-260628", draft: true }, actor)).ok).toBe(true);
  });
});

test("the options the control shows: the engine's own sizes each priced by the quote engine, the ladder sizes it cannot do greyed out 'not on this engine', native and upscaled 4K apart", async () => {
  const { prepareGeneration } = await import("../../lib/generationAdmission");
  const { quoteResolutionOptions } = await import("../../lib/resolutionQuote");
  const { estimateCostUsd } = await import("../../lib/vendorPricing");
  const { quotedCredits } = await import("../../lib/credits");
  const { UPSCALE_MODEL, NOT_ON_ENGINE } = await import("../../lib/resolutions");
  const ask = async (model: string, extra: Record<string, unknown> = {}) => {
    const out = await quoteResolutionOptions({ ...BODY, model, ...extra }, actor);
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    return out.body.options as import("../../lib/resolutionQuote").PricedOption[];
  };
  for (const house of [false, true]) {
    await inWorkspace(house ? "opth" : "optc", house, async () => {
      const unit = house ? "usd" : "cr";
      const platformKeys = !house;
      /* Seedance 2.5: 480p, 720p, 1080p natively; no native 4K; 4K upscaled from 1080p. */
      const seedance = await ask("dreamina-seedance-2-5-260628");
      expect(seedance.map((o) => [o.id, o.kind, o.available])).toEqual([["480p", "native", true], ["720p", "native", true], ["1080p", "native", true], ["4k", "native", false], ["4k-upscaled", "upscaled", true]]);
      expect(seedance.find((o) => o.id === "4k")).toMatchObject({ reason: NOT_ON_ENGINE });
      expect(seedance.find((o) => o.id === "4k")!.price).toBeUndefined();
      /* Every native price is the quote engine's, for that size. */
      for (const o of seedance.filter((x) => x.available && x.kind === "native")) {
        const q = await prepareGeneration({ ...BODY, model: "dreamina-seedance-2-5-260628", resolution: o.id }, actor);
        expect(q.ok).toBe(true);
        if (q.ok) expect(o, o.id).toMatchObject({ estimatedCredits: q.value.quote.estimatedCredits, price: q.value.quote.price, unit });
      }
      const prices = seedance.filter((x) => x.kind === "native" && x.available).map((x) => x.estimatedCredits!);
      expect([...prices].sort((a, b) => a - b)).toEqual(prices);
      expect(new Set(prices).size).toBe(prices.length);
      /* The upscaled 4K: the 1080p render and the upscale of that take, each priced, the total their sum. */
      const up = seedance.find((o) => o.id === "4k-upscaled")!;
      expect(up).toMatchObject({ kind: "upscaled", available: true, from: "1080p", via: UPSCALE_MODEL, unit });
      expect(up.steps).toHaveLength(2);
      const render = up.steps![0], upscale = up.steps![1];
      expect(render).toMatchObject({ tool: "render", resolution: "1080p", model: "dreamina-seedance-2-5-260628" });
      expect(render.estimatedCredits).toBe(seedance.find((o) => o.id === "1080p")!.estimatedCredits);
      const est = estimateCostUsd(UPSCALE_MODEL, "4k", "adaptive", 5, 5, true, { task: "upscale", fps60: false })!;
      expect(est.net).toBeGreaterThan(0);
      expect(upscale).toMatchObject({ tool: "upscale", resolution: "4k", model: UPSCALE_MODEL, estimatedCredits: quotedCredits(est.net, UPSCALE_MODEL), unit });
      expect(up.estimatedCredits).toBe(render.estimatedCredits + upscale.estimatedCredits);
      expect(up.estimatedCredits!).toBeGreaterThan(seedance.find((o) => o.id === "1080p")!.estimatedCredits!);
      /* No vendor dollar in a credit workspace's answer. */
      if (platformKeys) expect(JSON.stringify(seedance)).not.toContain(String(est.net));
      /* Seedance 2.0 lists a 4K of its own (untested): native 4K and the upscaled 4K are two options. */
      const two = await ask("dreamina-seedance-2-0-260128");
      expect(two.map((o) => [o.id, o.available])).toEqual([["480p", true], ["720p", true], ["1080p", true], ["4k", true], ["4k-upscaled", true]]);
      expect(two.find((o) => o.id === "4k")).toMatchObject({ kind: "native", untested: true });
      expect(two.find((o) => o.id === "4k-upscaled")).toMatchObject({ kind: "upscaled", from: "1080p" });
      expect(two.find((o) => o.id === "4k")!.estimatedCredits).not.toBe(two.find((o) => o.id === "4k-upscaled")!.estimatedCredits);
      /* Kling makes 1080p only. */
      const kling = await ask("fal-ai/kling-video/v3/standard");
      expect(kling.filter((o) => o.available).map((o) => o.id)).toEqual(["1080p", "4k-upscaled"]);
      expect(kling.filter((o) => !o.available).map((o) => [o.id, o.reason])).toEqual([["480p", NOT_ON_ENGINE], ["720p", NOT_ON_ENGINE], ["4k", NOT_ON_ENGINE]]);
      /* The upscale engine itself has one size, and no upscale of an upscale. */
      expect((await ask(UPSCALE_MODEL, { task: "upscale" })).map((o) => o.id)).toEqual(["4k"]);
      /* A still engine lists its own sizes, priced, and no video ladder. */
      const still = await quoteResolutionOptions({ prompt: "A bottle.", model: "gemini-3.1-flash-image", projectId: "project" }, actor);
      const stills = still.body.options as import("../../lib/resolutionQuote").PricedOption[];
      expect(stills.map((o) => o.id)).toEqual(["512", "1K", "2K", "4K"]);
      expect(stills.every((o) => o.available && o.kind === "native" && Number.isInteger(o.estimatedCredits))).toBe(true);
      /* A length the engine lists moves the price. */
      const long = await ask("dreamina-seedance-2-5-260628", { duration: 10 });
      expect(long.find((o) => o.id === "1080p")!.estimatedCredits!).toBeGreaterThan(seedance.find((o) => o.id === "1080p")!.estimatedCredits!);
      /* An unknown engine is a plain refusal. */
      expect(await quoteResolutionOptions({ ...BODY, model: "nope" }, actor)).toMatchObject({ status: 400, body: { error: "Unknown model: nope" } });
    });
  }
});

test("nothing in the options is a number of ours, and the quote path has no silent fallback left", () => {
  const options = readFileSync("lib/resolutions.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const quote = readFileSync("lib/resolutionQuote.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  expect(options).not.toMatch(/\d+\.\d+|\$\d/);
  expect(quote).not.toMatch(/\b\d+\.\d+\b/);
  expect(quote).toContain("prepareGeneration(");
  expect(quote).toContain("estimateCostUsd(");
  expect(quote).toContain("quotedCredits(");
  /* The admission picks a size through the one list and falls back to the engine's first size nowhere else. */
  const admission = readFileSync("lib/generationAdmission.ts", "utf8");
  expect(admission).toContain("pickResolution(model, body.resolution)");
  const fallbacks = admission.split("\n").filter((l) => /model\.resolutions\.includes\(body\.resolution\)\s*\?/.test(l) || /: model\.resolutions\[0\]/.test(l));
  expect(fallbacks).toEqual([]);
  /* The route is a read: it prices, it carries no spend marker. */
  const route = readFileSync("app/api/generate/resolutions/route.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(route).toContain("quoteResolutionOptions(");
  expect(route).not.toMatch(/\b(maxCredits|quoteOnly|withGenerationRequest|reserveGenerationSpend|executeGenerationAdmission|reserveRecoveryContinuation)\b/);
});
