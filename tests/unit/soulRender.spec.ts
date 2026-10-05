import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor, PreparedAdmission } from "../../lib/admissionTypes";
import type { StillRenderRequest } from "../../lib/engines/types";
import type { TenantWorkspace } from "../../lib/tenant";
import type { CreateSoulIdentityInput } from "../../lib/soulIdentities";

/**
 * Production › Cast on the platform's key: Soul ID training for each family
 * (v1 / v2 / cinema) at the fixed training price, and Soul Standard / Soul 2 /
 * Soul Cinema renders with an identity at the provider's live estimate, one
 * or four stills per request. Every provider call is stubbed or mocked
 * (ENGINE_MOCK=1); no request leaves the machine.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-soul-render-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const referenceId = "067e9e94-0bea-4acd-b82a-071a264d8e26";
const requestId = "117e9e94-0bea-4acd-b82a-071a264d8e26";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const PATHS = { v1: "higgsfield-ai/soul/standard", v2: "higgsfield-ai/soul/v2/standard", cinema: "higgsfield-ai/soul/cinema" } as const;
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.ENGINE_MOCK = "1";
  delete process.env.HF_CREDENTIALS;
});
/** A real provider mode for one test: its key, and every request answered by `reply`. */
function live(reply: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  process.env.ENGINE_MOCK = "0";
  process.env.HF_CREDENTIALS = "unit-key:unit-secret";
  const calls: { url: string; method?: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reply(String(url), init);
  };
  return calls;
}

test("each family's request builder: the documented path and body, strength above 0, 1 or 4 stills, 720p/1080p", async () => {
  const { soulRenderInput, SOUL_RENDER_PATHS, SoulRenderError } = await import("../../lib/soulRender");
  const { SOUL_RENDER_MODELS, soulVersionOf } = await import("../../lib/soulRenderTypes");
  const { getModel, isHiggsfieldImageModel, isSoulIdentityModel } = await import("../../lib/models");
  expect(SOUL_RENDER_PATHS).toEqual(PATHS);
  expect(SOUL_RENDER_MODELS).toEqual({ v1: "hf-soul-standard", v2: "hf-soul-2", cinema: "hf-soul-cinema" });
  for (const [version, id] of Object.entries(SOUL_RENDER_MODELS)) {
    expect(soulVersionOf(id)).toBe(version);
    const model = getModel(id);
    expect(model).toMatchObject({ provider: "higgsfield", kind: "image", soulIdentity: true, hidden: true, maxReferenceImages: 0, resolutions: ["720p", "1080p"] });
    expect(isSoulIdentityModel(id) && isHiggsfieldImageModel(id)).toBe(true);
    for (const batch of [1, 4]) {
      expect(soulRenderInput(id, { prompt: "Wren at the harbour", referenceId, strength: 0.8, batch, resolution: "1080p", ratio: "3:4" })).toEqual({
        prompt: "Wren at the harbour", custom_reference_id: referenceId, custom_reference_strength: 0.8, batch_size: batch,
        resolution: "1080p", aspect_ratio: "3:4", enhance_prompt: false,
      });
    }
  }
  const good = { prompt: "Wren", referenceId, strength: 1, batch: 1, resolution: "720p", ratio: "1:1" };
  for (const bad of [{ strength: 0 }, { strength: 1.2 }, { strength: NaN }, { batch: 2 }, { batch: 8 }, { resolution: "4k" }, { ratio: "21:9" }, { referenceId: "soul_local" }, { prompt: "   " }]) {
    expect(() => soulRenderInput("hf-soul-2", { ...good, ...bad })).toThrow(SoulRenderError);
  }
  expect(() => soulRenderInput("hf-soul-character", good)).toThrow(SoulRenderError);
});

test("the worker prices the exact body again and sends it once to the family's path; a changed or missing price sends nothing", async () => {
  const { SOUL_RENDER_MODELS } = await import("../../lib/soulRenderTypes");
  const { getModel } = await import("../../lib/models");
  const { higgsfield } = await import("../../lib/engines/higgsfield");
  const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  for (const version of ["v1", "v2", "cinema"] as const) {
    for (const batch of [1, 4]) {
      const calls = live((url) => url.includes("/estimate/") ? Response.json({ credits: 5 * batch, usd: 0.25 * batch }) : Response.json({ request_id: requestId, status: "queued", status_url: statusUrl }));
      const req: StillRenderRequest = { kind: "image", genId: "gen_soul_key", model: getModel(SOUL_RENDER_MODELS[version]), prompt: "Wren at the harbour", ratio: "3:4", size: "1080p", references: [],
        soulReferenceId: referenceId, soulCredentialFingerprint: higgsfieldCredentialFingerprint(), soulStrength: 0.6, soulBatch: batch, soulVendorCostUsd: 0.25 * batch };
      const out = await higgsfield.render(req);
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`POST https://api.higgsfield.ai/estimate/${PATHS[version]}`, `POST https://api.higgsfield.ai/${PATHS[version]}`]);
      const body = { prompt: "Wren at the harbour", custom_reference_id: referenceId, custom_reference_strength: 0.6, batch_size: batch, resolution: "1080p", aspect_ratio: "3:4", enhance_prompt: false };
      expect(calls[0].body).toEqual(body);
      expect(calls[1].body).toEqual(body);
      expect(out).toMatchObject({ handle: { ref: requestId, endpoint: statusUrl, model: SOUL_RENDER_MODELS[version] } });
    }
  }
  const req = (): StillRenderRequest => ({ kind: "image", genId: "gen_soul_key", model: getModel("hf-soul-2"), prompt: "Wren", ratio: "3:4", size: "720p", references: [],
    soulReferenceId: referenceId, soulCredentialFingerprint: higgsfieldCredentialFingerprint(), soulStrength: 1, soulBatch: 1, soulVendorCostUsd: 0.25 });
  /* A changed price, a price in words, a refusal: each is answered fresh (a cloned body cannot be cancelled on its own). */
  for (const reply of [() => Response.json({ credits: 9, usd: 0.3 }), () => Response.json({ type: "description", pricing_description: "per image" }), () => new Response("{}", { status: 422 })]) {
    const calls = live(reply);
    await expect(higgsfield.render(req())).rejects.toThrow(/Nothing was submitted/);
    expect(calls.map((c) => c.url)).toEqual([`https://api.higgsfield.ai/estimate/${PATHS.v2}`]);
  }
});

test("a live estimate is a positive number (or numeric text); anything else is no price, and the render is refused", async () => {
  const { estimateSoulRender, soulRenderInput, SoulRenderError } = await import("../../lib/soulRender");
  const body = soulRenderInput("hf-soul-cinema", { prompt: "Wren", referenceId, strength: 1, batch: 4, resolution: "1080p", ratio: "3:4" });
  for (const [reply, usd] of [[{ credits: 20, usd: 1.25 }, 1.25], [{ usd: "1.25" }, 1.25]] as const) {
    const calls = live(() => Response.json(reply));
    expect(await estimateSoulRender("hf-soul-cinema", body)).toBe(usd);
    expect(calls).toEqual([{ url: `https://api.higgsfield.ai/estimate/${PATHS.cinema}`, method: "POST", body }]);
  }
  for (const reply of [{ type: "description", pricing_description: "per image, 720p / 1080p" }, { usd: 0 }, { usd: "free" }, { credits: 3 }, { usd: -1 }]) {
    live(() => Response.json(reply));
    const error = await estimateSoulRender("hf-soul-cinema", body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SoulRenderError);
    expect(error).toMatchObject({ code: "price_unavailable", status: 503 });
  }
  live(() => new Response("{}", { status: 422 }));
  await expect(estimateSoulRender("hf-soul-cinema", body)).rejects.toMatchObject({ code: "price_unavailable" });
  live(() => new Response("{}", { status: 429 }));
  await expect(estimateSoulRender("hf-soul-cinema", body)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  live(() => { throw new Error("network down"); });
  await expect(estimateSoulRender("hf-soul-cinema", body)).rejects.toMatchObject({ code: "price_unavailable" });
});

test("settlement stays within the band: the quote stands unless a stated charge is between half and three times it", async () => {
  const { soulRenderSettlementUsd, soulRenderDelivered, soulBatchTakeId, soulBatchId } = await import("../../lib/soulRender");
  const { isBatchId } = await import("../../lib/variations");
  expect(soulRenderSettlementUsd(1)).toBe(1);
  expect(soulRenderSettlementUsd(1, null)).toBe(1);
  expect(soulRenderSettlementUsd(1, 0.5)).toBe(0.5);
  expect(soulRenderSettlementUsd(1, 2.5)).toBe(2.5);
  expect(soulRenderSettlementUsd(1, 3)).toBe(3);
  for (const wild of [0.49, 3.01, 100, 0, -1, NaN, Infinity]) expect(soulRenderSettlementUsd(1, wild)).toBe(1);
  expect(soulRenderDelivered(["a"], 1)).toEqual(["a"]);
  expect(soulRenderDelivered(["a", "b", "c"], 4)).toEqual(["a", "b", "c"]);
  for (const [urls, batch] of [[[], 1], [["a", "b"], 1], [["a", "b", "c", "d", "e"], 4], [["a"], 2]] as const)
    expect(() => soulRenderDelivered(urls, batch)).toThrow(/image count/);
  expect(soulBatchTakeId("gen_abc", 3)).toBe("gen_abc-3");
  expect(isBatchId(soulBatchId("gen_abc"))).toBe(true);
  expect(soulBatchId("gen_abc")).toBe(soulBatchId("gen_abc"));
});

test("training sends the chosen family as model_version, and no other version is ever sent", async () => {
  const { createSoulReference } = await import("../../lib/higgsfield");
  for (const version of ["v1", "v2", "cinema"] as const) {
    const calls = live(() => Response.json({ id: referenceId, status: "queued" }));
    expect(await createSoulReference("Wren", ["https://files.example/wren-1.png"], { modelVersion: version })).toEqual({ id: referenceId, status: "queued" });
    expect(calls).toEqual([{ url: "https://api.higgsfield.ai/v1/custom-references", method: "POST",
      body: { name: "Wren", model_version: version, input_images: [{ type: "image_url", image_url: "https://files.example/wren-1.png" }] } }]);
  }
  const calls = live(() => Response.json({ id: referenceId, status: "queued" }));
  await expect(createSoulReference("Wren", ["https://files.example/a.png"], { modelVersion: "v3" as never })).rejects.toThrow(/supported identity version/);
  expect(calls).toEqual([]);
});

/* ── Tenants ──────────────────────────────────────────────────────────── */

const actor: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };
const nodeRequire = createRequire(path.resolve("package.json"));
let dispatched: { genId: string; kind: string }[] = [];
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => name in overrides ? overrides[name]
      : name.startsWith("@/") ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
      : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), name + ".ts")) : nodeRequire(name),
    target, target.exports,
  );
  return target.exports as T;
}
const admission = () => load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
  "@/lib/inngest": { enqueueRender: async (genId: string, kind: string) => { dispatched.push({ genId, kind }); return true; } },
});
const noInline = () => { throw new Error("Durable dispatch acknowledged; inline work must not run"); };

/** A workspace on the platform's keys with credits and a production called `project`. */
async function tenant<T>(name: string, fn: (gen: ReturnType<typeof admission>, ws: TenantWorkspace) => Promise<T>): Promise<T> {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  await grantCredits(name, 10000, "Test", "owner", "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  dispatched = [];
  return runInTenant(ws, async () => {
    await ready();
    await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
    await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
    return fn(admission(), ws);
  }, actor);
}
/** A trained identity row, as training leaves it once settled. */
async function identity(id: string, fields: { version?: string | null; origin?: string | null; status?: string; production?: string | null } = {}) {
  const { db } = await import("../../lib/db");
  const { soulIdentitiesReady } = await import("../../lib/soulIdentities");
  const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  await soulIdentitiesReady();
  await db().execute({
    sql: `INSERT INTO soul_identities(id,owner,production_project_id,name,description,subject_type,references_json,status,provider_reference_id,credential_fingerprint,settled_at,created_at,updated_at,consent_at,provider_origin,model_version)
      VALUES(?,'owner',?,?,'','character','[]',?,?,?,1,1,1,1,?,?)`,
    args: [id, fields.production === undefined ? "project" : fields.production, `Identity ${id}`, fields.status ?? "ready", referenceId, higgsfieldCredentialFingerprint(),
      fields.origin === undefined ? "api-v1" : fields.origin, fields.version === undefined ? "v2" : fields.version],
  });
}
function value(result: Awaited<ReturnType<ReturnType<typeof admission>["prepareGeneration"]>>): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
async function counts() {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return {
    generations: Number((await db().execute("SELECT COUNT(*) AS n FROM generations")).rows[0].n),
    meters: Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows[0].n),
  };
}
const body = (patch: Record<string, unknown> = {}) => ({ model: "hf-soul-2", prompt: "Wren on the quay at dusk", projectId: "project", ratio: "3:4", resolution: "1080p",
  soulIdentityId: "soul_v2", soulStrength: 0.8, soulBatch: 4, refine: false, ...patch });

test("training: v1 keeps its price; Soul 2 and Soul Cinema are offered only at a privately configured price, charged that cost with the markup, and refused while unset", async () => {
  const { soulTrainingUsd, SOUL_TRAINING_USD } = await import("../../lib/soulIdentities");
  const names = ["SOUL_TRAINING_USD_V2", "SOUL_TRAINING_USD_CINEMA"] as const;
  const saved = names.map((name) => process.env[name]);
  /* Made-up operator figures, set only here: never a provider's price. */
  const V2 = 7.25, CINEMA = 9.5;
  try {
    for (const name of names) delete process.env[name];
    expect(soulTrainingUsd("v1")).toBe(SOUL_TRAINING_USD);
    expect(soulTrainingUsd("v2")).toBeNull();
    expect(soulTrainingUsd("cinema")).toBeNull();
    for (const bad of ["0", "-3", "abc", " ", "Infinity"]) {
      process.env.SOUL_TRAINING_USD_V2 = bad;
      expect(soulTrainingUsd("v2"), bad).toBeNull();
    }
    delete process.env.SOUL_TRAINING_USD_V2;
    for (const version of ["v3", "", null, undefined, "V1"]) expect(soulTrainingUsd(version)).toBeNull();
    expect(soulTrainingUsd("cinema", { v1: SOUL_TRAINING_USD })).toBeNull();
    await tenant("soul_training_versions", async () => {
      const { db } = await import("../../lib/db");
      const { platformDb } = await import("../../lib/platform");
      const { saveDraft } = await import("../../lib/workbench/records");
      const { newProject } = await import("../../lib/workbench/studio");
      const { billCredits } = await import("../../lib/creditTerms");
      const { soulIdentityTerms, createSoulIdentity, syncSoulIdentity, soulIdentitiesReady, SoulIdentityError } = await import("../../lib/soulIdentities");
      await soulIdentitiesReady();
      const { withGenerationRequestData, generationFingerprint } = await import("../../lib/generationRequests");
      const credits = (usd: number) => billCredits(usd, "identity-training");
      /* Unset: only v1 is offered, at its price as before. */
      expect(soulIdentityTerms().versions).toEqual([{ version: "v1", trainingCredits: credits(SOUL_TRAINING_USD) }]);
      expect(soulIdentityTerms().trainingCredits).toBe(credits(SOUL_TRAINING_USD));
      await db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('face','Face','image/png','png',100,'hash','/api/uploads/face',0)");
      const draft = newProject("Identity production");
      await saveDraft(actor.user.id, draft, 0);
      const input = (version: string | undefined, maxCredits: number, name = `Wren ${version}`): CreateSoulIdentityInput => ({ projectId: draft.id, name, description: "", subjectType: "character",
        references: [{ uploadId: "face" }], consent: true, maxCredits, modelVersion: version as CreateSoulIdentityInput["modelVersion"] });
      const seen: unknown[] = [];
      const train = (value: CreateSoulIdentityInput, key: string) => withGenerationRequestData({ userId: actor.user.id, key, fingerprint: generationFingerprint(value) }, async (claim) => {
        try {
          return Response.json({ identity: await createSoulIdentity(value, claim, { submit: async (_name, _urls, options) => { seen.push(options); return { id: referenceId, status: "queued" as const }; } }) }, { status: 202 });
        } catch (error) {
          if (error instanceof SoulIdentityError) return Response.json({ error: error.message }, { status: error.status });
          throw error;
        }
      });
      const rows = async () => Number((await db().execute("SELECT COUNT(*) AS n FROM soul_identities")).rows[0].n);
      /* An unpriced family (unset, or unknown): refused before any row, reservation or provider request. */
      for (const [version, key] of [["v2", "train-v2-unset"], ["cinema", "train-cinema-unset"], ["v3", "train-v3"]] as const) {
        const before = { identities: await rows(), sent: seen.length };
        const refused = await train(input(version, 9999), key);
        expect(refused.status, version).toBe(400);
        expect((await refused.json()).error).toMatch(/no training price/);
        expect(await rows()).toBe(before.identities);
        expect(seen.length).toBe(before.sent);
      }
      /* Priced privately: offered, and each costs its own figure, converted to credits with the markup. */
      process.env.SOUL_TRAINING_USD_V2 = String(V2);
      process.env.SOUL_TRAINING_USD_CINEMA = String(CINEMA);
      expect(soulIdentityTerms().versions).toEqual([
        { version: "v1", trainingCredits: credits(SOUL_TRAINING_USD) },
        { version: "v2", trainingCredits: credits(V2) },
        { version: "cinema", trainingCredits: credits(CINEMA) },
      ]);
      /* An approval below the version's own price is a changed quote. */
      expect((await train(input("cinema", credits(CINEMA) - 1), "train-cinema-low")).status).toBe(409);
      const reply = await train(input("cinema", credits(CINEMA)), "train-cinema");
      expect(reply.status).toBe(202);
      const trained = (await reply.json()).identity;
      expect(trained.renderModel).toBe("hf-soul-cinema");
      expect(seen.at(-1)).toEqual({ modelVersion: "cinema" });
      expect((await db().execute({ sql: "SELECT model_version,provider_origin,cost_usd FROM soul_identities WHERE id=?", args: [trained.id] })).rows[0])
        .toMatchObject({ model_version: "cinema", provider_origin: "api-v1", cost_usd: CINEMA });
      const reserved = (await platformDb().execute({ sql: "SELECT status,engine_cost_usd FROM meter_events WHERE id=?", args: [trained.id] })).rows[0];
      expect(reserved.status).toBe("running");
      expect(Number(reserved.engine_cost_usd)).toBe(CINEMA);
      /* The price it was sent at stands, even if the configured figure moves before it settles. */
      process.env.SOUL_TRAINING_USD_CINEMA = String(CINEMA * 2);
      const ready = await syncSoulIdentity(trained.id, { poll: async () => ({ id: referenceId, status: "completed" as const }) });
      expect(ready?.status).toBe("ready");
      const settled = (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE id=?", args: [trained.id] })).rows[0];
      expect(settled.status).toBe("succeeded");
      expect(Number(settled.engine_cost_usd)).toBe(CINEMA);
      expect(ready?.creditsBilled).toBe(credits(CINEMA));
      /* No version named: v1, at its price, as before. */
      const v1 = await (await train(input(undefined, credits(SOUL_TRAINING_USD), "Wren default"), "train-default")).json();
      expect(v1.identity.renderModel).toBe("hf-soul-standard");
      expect(Number((await platformDb().execute({ sql: "SELECT engine_cost_usd FROM meter_events WHERE id=?", args: [v1.identity.id] })).rows[0].engine_cost_usd)).toBe(SOUL_TRAINING_USD);
    });
  } finally {
    names.forEach((name, i) => { if (saved[i] == null) delete process.env[name]; else process.env[name] = saved[i]; });
  }
});

test("admission: a ready identity renders only with its own family, at the live estimate of the exact request; 1 or 4 stills", async () =>
  tenant("soul_render_admission", async (gen) => {
    const { billCredits } = await import("../../lib/creditTerms");
    const { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
    await identity("soul_v2");
    await identity("soul_cinema", { version: "cinema" });
    await identity("soul_earlier", { origin: null, version: null });
    await identity("soul_training", { status: "training" });
    const { db } = await import("../../lib/db");
    await db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('face','Face','image/png','png',100,'hash','/api/uploads/face',0)");
    for (const batch of [1, 4]) {
      const prepared = value(await gen.prepareGeneration(body({ soulBatch: batch, soulReferenceId: "attacker-uuid", soulVendorCostUsd: 0 }), actor));
      /* The mock estimate is a synthetic 0.25 a still: the quote is that request's price, in credits. */
      expect(prepared.quote.estimatedCredits).toBe(billCredits(0.25 * batch, "hf-soul-2"));
      expect(prepared.compiled.params).toMatchObject({ soulIdentityId: "soul_v2", soulReferenceId: referenceId, soulStrength: 0.8, soulBatch: batch,
        soulVendorCostUsd: 0.25 * batch, soulCredentialFingerprint: higgsfieldCredentialFingerprint(), ratio: "3:4", resolution: "1080p" });
    }
    const refusals: [Record<string, unknown>, number, RegExp][] = [
      [{ model: "hf-soul-standard" }, 409, /renders with Identity still · 2/],
      [{ model: "hf-soul-2", soulIdentityId: "soul_cinema" }, 409, /renders with Identity still · Cinema/],
      [{ soulIdentityId: "soul_earlier" }, 409, /earlier host/],
      [{ soulIdentityId: "soul_training" }, 400, /not ready/],
      [{ soulIdentityId: "missing" }, 400, /not available/],
      [{ soulBatch: 2 }, 400, /1 or 4 stills/],
      [{ soulStrength: 0 }, 400, /above 0/],
      [{ resolution: "4k" }, 400, /720p or 1080p/],
      [{ ratio: "21:9" }, 400, /720p or 1080p/],
      [{ references: [{ uploadId: "face", role: "reference_image" }] }, 400, /reference/],
      [{ model: "gemini-3.1-flash-image", resolution: "1K" }, 400, /cannot use a trained identity/],
    ];
    for (const [patch, status, message] of refusals) {
      const result = await gen.prepareGeneration(body(patch), actor);
      expect(result, JSON.stringify(patch)).toMatchObject({ ok: false, status });
      expect(JSON.stringify(!result.ok && result.body), JSON.stringify(patch)).toMatch(message);
    }
    expect(await counts()).toEqual({ generations: 0, meters: 0 });
    /* Without a reviewed quote (no checkpoint) nothing is admitted. */
    const direct = await gen.executeGenerationAdmission({ ...body(), maxCredits: 999 }, actor, { requestClaim: undefined as never, defer: noInline });
    expect(direct).toMatchObject({ status: 400 });
    expect(JSON.stringify(direct.body)).toMatch(/live identity render quote/);
    expect(await counts()).toEqual({ generations: 0, meters: 0 });
  }));

test("no price, no render: an estimate without a number refuses the quote and nothing is written or sent", async () =>
  tenant("soul_render_unpriced", async (gen) => {
    const calls = live((url) => url.includes("/estimate/") ? Response.json({ type: "description", pricing_description: "per image" }) : Response.json({ request_id: requestId }));
    await identity("soul_v2");
    const result = await gen.prepareGeneration(body(), actor);
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(!result.ok && result.body)).toMatch(/no price/);
    expect(calls.map((c) => c.url)).toEqual([`https://api.higgsfield.ai/estimate/${PATHS.v2}`]);
    expect(await counts()).toEqual({ generations: 0, meters: 0 });
  }));

test("isolation: identities belong to their workspace; the list is this workspace's own rows and never the provider's", async () => {
  await tenant("soul_home", async () => { await identity("soul_home_only"); });
  await tenant("soul_other", async (gen) => {
    let asked = 0;
    globalThis.fetch = async () => { asked++; throw new Error("Unexpected external request"); };
    const { listSoulIdentities } = await import("../../lib/soulIdentities");
    expect(await listSoulIdentities()).toEqual([]);
    /* Another workspace's identity id is unknown here: refused before any estimate. */
    const result = await gen.prepareGeneration(body({ soulIdentityId: "soul_home_only" }), actor);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(JSON.stringify(!result.ok && result.body)).toMatch(/not available in this workspace/);
    await identity("soul_mine");
    const listed = await listSoulIdentities();
    expect(listed.map((i) => [i.id, i.renderModel])).toEqual([["soul_mine", "hf-soul-2"]]);
    expect(asked).toBe(0);
  });
});

test("a batch of 4 is one paid request: its take carries the whole price, and the other three stills are filed once as takes of their own", async () =>
  tenant("soul_render_batch", async (gen) => {
    const { db } = await import("../../lib/db");
    const { platformDb } = await import("../../lib/platform");
    const { loadJob, produce, reconcileHiggsfieldImage } = await import("../../lib/renderWork");
    const { getGeneration } = await import("../../lib/jobs");
    const { engineFor } = await import("../../lib/engines");
    await identity("soul_v2");
    const prepared = value(await gen.prepareGeneration(body(), actor));
    const accepted = await gen.admitGeneration(prepared, actor, { requestKey: "soul-batch-of-four", defer: noInline });
    expect(accepted, JSON.stringify(accepted.body)).toMatchObject({ status: 200, body: { status: "running" } });
    const genId = String(accepted.body.id);
    expect(dispatched).toEqual([{ genId, kind: "image" }]);
    const reserved = (await platformDb().execute({ sql: "SELECT status,engine_cost_usd FROM meter_events WHERE id=?", args: [genId] })).rows[0];
    expect(reserved).toMatchObject({ status: "running" });
    expect(Number(reserved.engine_cost_usd)).toBe(1);
    const engine = engineFor("higgsfield"), render = engine.render;
    let sent = 0;
    engine.render = async (req) => { sent++; return render(req); };
    const stored: string[] = [];
    try {
      expect(await produce((await loadJob(genId))!)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 3200)); // the mock request finishes three seconds after it is sent
      await reconcileHiggsfieldImage(genId);
      await reconcileHiggsfieldImage(genId);
    } finally { engine.render = render; }
    expect(sent).toBe(1);
    const rows = (await db().execute({ sql: "SELECT id,status,cost_usd,params,stored_url,model,project_id FROM generations ORDER BY id" })).rows;
    const ids = [genId, `${genId}-2`, `${genId}-3`, `${genId}-4`];
    expect(rows.map((r) => r.id)).toEqual(ids);
    stored.push(...ids);
    for (const row of rows) expect(row).toMatchObject({ status: "succeeded", model: "hf-soul-2", project_id: "project", stored_url: expect.any(String) });
    const leader = (await getGeneration(genId))!;
    expect(leader.params).toMatchObject({ soulBatchIds: ids, variation: 1, soulIdentityId: "soul_v2", soulBatch: 4 });
    for (const key of ["soulReferenceId", "soulCredentialFingerprint", "soulVendorCostUsd", "higgsfieldStillHandle", "paidClaim"]) expect(leader.params).not.toHaveProperty(key);
    for (const [i, id] of ids.slice(1).entries()) {
      const take = (await getGeneration(id))!;
      expect(take.params).toMatchObject({ soulBatchOf: genId, batchId: (leader.params as { batchId: string }).batchId, variation: i + 2, soulIdentityId: "soul_v2" });
      expect(take.creditsBilled).toBe(0);
    }
    /* One bill, for the one request, at its quoted estimate. */
    const bills = (await platformDb().execute({ sql: "SELECT id,status,engine_cost_usd FROM meter_events WHERE id LIKE ?", args: [`${genId}%`] })).rows;
    expect(bills.map((b) => [b.id, b.status, Number(b.engine_cost_usd)])).toEqual([[genId, "succeeded", 1]]);
    expect(Number(rows[0].cost_usd)).toBe(1);
    for (const row of rows.slice(1)) expect(Number(row.cost_usd)).toBe(0);
    for (const id of stored) await unlink(path.join(process.cwd(), ".data", "generations", `${id}.png`)).catch(() => {});
  }));

test("an identity render the provider fails settles at zero, and its card says what the ledger kept", async () =>
  tenant("soul_render_failed", async (gen) => {
    const { reconcileHiggsfieldImage, loadJob, produce } = await import("../../lib/renderWork");
    const { getGeneration } = await import("../../lib/jobs");
    const { withLedgerCharges } = await import("../../lib/usageLedger");
    const { engineFor } = await import("../../lib/engines");
    const { renderOutcome } = await import("../../lib/production/cast-render");
    await identity("soul_v2");
    const accepted = await gen.admitGeneration(value(await gen.prepareGeneration(body({ soulBatch: 1 }), actor)), actor, { requestKey: "soul-failed-render", defer: noInline });
    const genId = String(accepted.body.id);
    expect(await produce((await loadJob(genId))!)).toBeNull();
    const engine = engineFor("higgsfield"), poll = engine.poll;
    /* The provider's own reply for a moderated request: its status says why (lib/engines/higgsfield.ts reads it so). */
    engine.poll = async () => ({ status: "failed", imageUrl: null, videoUrl: null, totalTokens: null, error: "The connected account rejected this generation during moderation.", vendorStartedAt: null, vendorEndedAt: null, raw: { status: "nsfw" } });
    try { await reconcileHiggsfieldImage(genId); } finally { engine.poll = poll; }
    const failed = (await getGeneration(genId))!;
    expect(failed.status).toBe("failed");
    expect(failed.creditsBilled).toBe(0);
    /* On the platform's key the provider's own billing stays private; the ledger speaks for the charge. */
    expect(failed.failure).toMatchObject({ provider: "higgsfield", kind: "content_filter", payer: "platform", billing: null });
    /* Before the ledger is read the line claims nothing about the charge; the route (GET /api/jobs/:id) adds the ledger's word. */
    expect(renderOutcome(failed)).toBe("Refused by the content filter · Change the prompt or reference");
    const [read] = await withLedgerCharges([failed]);
    expect(read.failure?.charge).toEqual({ credits: 0, settled: true });
    expect(renderOutcome(read)).toBe("Refused by the content filter · Not billed · Change the prompt or reference");
  }));

test("the Cast page's request and filing: a character, its own identity, its family's model; old entries read-only; an earlier account's identity is told apart", async () => {
  const { castRenderInput, renderedStills, renderOutcome, renderableIdentity } = await import("../../lib/production/cast-render");
  const { generationRequestBody } = await import("../../lib/workbench/generation-request");
  const { newEntry, retiredModelOf, accountSoulIdOf } = await import("../../lib/production/cast");
  const project = { id: "draft-1", productionProjectId: "prod-1" };
  const soul = { id: "soul_a", status: "ready" as const, renderModel: "hf-soul-cinema", projectId: null, name: "Wren", description: "", subjectType: "character" as const,
    references: [], previewUrl: null, createdAt: 0, updatedAt: 0, creditsBilled: 38, error: null };
  const wren = { ...newEntry("character", "Wren", "", "Wren on the quay"), identityId: "soul_a", soulBatch: 4 as const, soulResolution: "1080p" as const, soulStrength: 0.8 };
  const input = castRenderInput(project, wren, soul)!;
  expect(generationRequestBody(input)).toEqual({ prompt: "Wren on the quay", model: "hf-soul-cinema", projectId: "prod-1", shotId: "", ratio: "3:4", resolution: "1080p", duration: 5,
    refine: false, references: [], soulIdentityId: "soul_a", soulStrength: 0.8, workbenchProjectId: "draft-1", soulBatch: 4 });
  expect(castRenderInput(project, { ...wren, prompt: " " }, soul)).toBeNull();
  expect(castRenderInput(project, { ...wren, identityId: "soul_b" }, soul)).toBeNull();
  expect(castRenderInput(project, { ...wren, kind: "element" }, soul)).toBeNull();
  expect(castRenderInput({ id: "draft-1" }, wren, soul)).toBeNull();
  for (const unusable of [{ status: "training" as const }, { renderModel: null }, { renderModel: "hf-soul-character" }]) {
    expect(renderableIdentity({ ...soul, ...unusable })).toBe(false);
    expect(castRenderInput(project, wren, { ...soul, ...unusable })).toBeNull();
  }
  expect(castRenderInput(project, { ...wren, soulStrength: 0.35 }, soul)!.soul!.soulStrength).toBe(1);
  expect(renderedStills({ id: "gen_a", params: { soulBatchIds: ["gen_a", "gen_a-2", "gen_a-3", "gen_a-4"] } })).toEqual(["gen_a", "gen_a-2", "gen_a-3", "gen_a-4"]);
  expect(renderedStills({ id: "gen_a", params: { soulBatchIds: ["gen_b"] } })).toEqual(["gen_a"]);
  expect(renderedStills({ id: "gen_a", params: {} })).toEqual(["gen_a"]);
  /* A failed render says what every other take says (lib/errors.ts failureLine): held while the reservation is open,
     charged once settled, "Not billed" only when settled at nothing, the provider's own outcome on the workspace's key. */
  const refused = { provider: "higgsfield", stage: "run", code: "nsfw", kind: "content_filter", message: null, billing: null, payer: "platform" } as const;
  expect(renderOutcome({ status: "failed", failure: { ...refused, charge: { credits: 12, settled: false } } })).toBe("Refused by the content filter · 12 cr held · Change the prompt or reference");
  expect(renderOutcome({ status: "failed", failure: { ...refused, charge: { credits: 12, settled: true } } })).toBe("Refused by the content filter · 12 cr charged · Change the prompt or reference");
  expect(renderOutcome({ status: "failed", failure: { ...refused, charge: { credits: 0, settled: true } } })).toBe("Refused by the content filter · Not billed · Change the prompt or reference");
  expect(renderOutcome({ status: "failed", failure: { ...refused, charge: { credits: 0, settled: false } } })).toBe("Refused by the content filter · Settling · Change the prompt or reference");
  expect(renderOutcome({ status: "failed", error: "Refused by the content filter", failure: refused })).toBe("Refused by the content filter · Change the prompt or reference");
  expect(renderOutcome({ status: "failed", failure: { ...refused, payer: "own", billing: { state: "refunded", amount: 12, unit: "higgsfield_credits", basis: "hf-refund" } } }))
    .toBe("Refused by the content filter · The engine refunded 12 credits · Change the prompt or reference");
  /* A held render discarded before it started: cancelled, and the receipt says nothing was kept. */
  expect(renderOutcome({ status: "cancelled", failure: { provider: null, stage: null, code: "unknown", kind: "unknown", message: null, billing: null, payer: null, charge: { credits: 0, settled: true } } }))
    .toBe("Cancelled · Not billed · Render again");
  /* A record from before failures were kept: its reason, and no word on the charge. */
  expect(renderOutcome({ status: "failed", error: "Stopped." })).toBe("Stopped.");
  expect(renderOutcome({ status: "cancelled" })).toBe("The render was cancelled.");
  /* Built earlier with a stills model that made a place or a persona: read-only, named without the old family word. Never built, or the two character models: editable. */
  const built = { takes: [{ genId: "gen_hfc_1", at: "2026-09-24T00:00:00.000Z" }] };
  expect(retiredModelOf({ ...newEntry("element", "Harbour"), model: "soul_location", ...built })).toBe("Location still");
  expect(retiredModelOf({ ...newEntry("character", "Nova"), model: "soul_cast", elementId: "el_1" })).toBe("Persona still");
  expect(retiredModelOf({ ...newEntry("element", "Harbour"), model: "soul_location" })).toBeNull();
  expect(retiredModelOf({ ...newEntry("character", "Wren"), model: "soul_cinematic", ...built })).toBeNull();
  expect(retiredModelOf({ ...newEntry("character", "Wren"), model: "soul_2", ...built })).toBeNull();
  expect(retiredModelOf({ ...newEntry("character", "Wren"), model: "soul_future_model", ...built })).toBe("an earlier engine");
  expect(accountSoulIdOf({ ...newEntry("character", "Wren"), soulId: "acct-soul-1" })).toBe("acct-soul-1");
  expect(accountSoulIdOf({ ...newEntry("character", "Wren"), soulId: "acct-soul-1", identityId: "soul_a" })).toBeNull();
  expect(accountSoulIdOf({ ...newEntry("element", "Lamp"), soulId: "acct-soul-1" })).toBeNull();
});

test("old projects keep loading: every saved soul_* model and the account fields still validate, beside the key's new fields", async () => {
  const { productionSchema } = await import("../../lib/workbench/studio-schema");
  const entry = (patch: Record<string, unknown>) => ({ id: "cast-1", name: "Wren", kind: "character", description: "", prompt: "", takes: [], ...patch });
  for (const model of ["soul_cinematic", "soul_2", "soul_location", "soul_cast", "soul_future_model"])
    expect(productionSchema.safeParse({ cast: { entries: [entry({ model, soulId: "acct-soul", quality: "2k", budget: 50, elementId: "el_1", job: { id: requestId, status: "submitted" } })] } }).success, model).toBe(true);
  expect(productionSchema.safeParse({ cast: { entries: [entry({ identityId: "soul_a", soulBatch: 4, soulResolution: "1080p", soulStrength: 0.6,
    pending: [{ jobId: "gen_a", at: "2026-09-28T10:00:00.000Z", batch: 4 }] })] } }).success).toBe(true);
  for (const bad of [{ model: "flux" }, { soulBatch: 2 }, { soulStrength: 0 }, { soulResolution: "4k" }, { identityId: "../x" }])
    expect(productionSchema.safeParse({ cast: { entries: [entry(bad)] } }).success, JSON.stringify(bad)).toBe(false);
});
