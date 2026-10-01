import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import type { AdmissionActor, PreparedAdmission, PrepareAdmissionResult } from "../../lib/admissionTypes";
import type { Reference, VideoParams } from "../../lib/ark";
import type { VideoRenderRequest } from "../../lib/engines/types";
import type { ComposerModel } from "../../lib/workspace/composer";
import { CINEMA_STUDIO_MODEL_ID } from "../../lib/cinemaStudioTypes";

/**
 * Cinema Studio 4.0's Sound switch, and its Movement on Auto.
 *
 * - Gen and the canvas dialog offer a Sound switch, off by default. A request
 *   carries `generateAudio` only when it is on; a sound reference never turns
 *   it on.
 * - The provider is always told `generate_audio` (its own default is sound
 *   on): false unless the switch is on.
 * - The switch is in the price's key and in the approval's fingerprint. The
 *   figure stays the published formula's, which names no charge for sound;
 *   the watched pricing text is pinned to the rates the quote uses.
 * - Movement on Auto writes no camera sentence: the camera is the model's to
 *   choose. A picked movement goes as its own parameter, and every other
 *   engine's camera module is as it was.
 *
 * All mocked: ENGINE_MOCK=1, injected fetches, local databases.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-cinema-sound-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
const originalFetch = globalThis.fetch;
const requestId = "7e3f6a3c-4d5e-4f70-8b12-c3d4e5f6a7b8";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const cancelUrl = `https://api.higgsfield.ai/requests/${requestId}/cancel`;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
const SEEDANCE = "dreamina-seedance-2-5-260628";
const KLING = "fal-ai/kling-video/v3/standard";
const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)((name: string) => {
    if (name in overrides) return overrides[name];
    return name.startsWith("@/") ? nodeRequire(path.resolve(`${name.slice(2)}.ts`))
      : name.startsWith(".") ? nodeRequire(path.resolve(path.dirname(file), `${name}.ts`)) : nodeRequire(name);
  }, target, target.exports);
  return target.exports as T;
}
test.beforeEach(() => {
  delete process.env.HF_CINEMA_STUDIO_ENABLED;
  process.env.ENGINE_MOCK = "1";
  process.env.HF_CREDENTIALS = "fixture:key";
  globalThis.fetch = async () => { throw new Error("External network forbidden"); };
});
test.afterEach(() => { globalThis.fetch = originalFetch; process.env.ENGINE_MOCK = "1"; });

const settings = (patch: Partial<VideoParams> = {}): VideoParams =>
  ({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, generateAudio: false, hasVideoInput: false, ...patch });
const wav = (id: string): Reference => ({ id, kind: "audio", mime: "audio/wav", ext: "wav", storedUrl: `/api/uploads/${id}`, role: "reference_audio" });
/** Gen's model rows, as the composer holds them. */
const CINEMA_ROW: ComposerModel = { id: CINEMA_STUDIO_MODEL_ID, label: "Cinema Studio 4.0", type: "video", ratios: ["16:9", "9:16"], resolutions: ["720p", "480p"], durations: [4, 5, 6] };
const SEEDANCE_ROW: ComposerModel = { id: SEEDANCE, label: "Seedance 2.5", type: "video", ratios: ["16:9"], resolutions: ["720p"], durations: [5] };

function workspace(name: string): TenantWorkspace {
  return { id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 20, rendersPerHour: 200, storageQuotaBytes: null, deletedAt: null };
}

/* ── Gen and the canvas dialog: off by default, sent only when on ────── */

test("the Sound switch is off by default, offered only for Cinema Studio on this workspace's credits, and a request carries generateAudio only when it is on", async () => {
  const { composerReducer, composerSettings, quoteKeyFor, soundOffered, INITIAL_COMPOSER } = await import("../../lib/workspace/composer");
  const { generationRequestBody } = await import("../../lib/workbench/generation-request");
  /* Off until it is turned on. */
  expect(INITIAL_COMPOSER.picks).toEqual({});
  expect(composerSettings(CINEMA_ROW, "16:9", INITIAL_COMPOSER.picks)).not.toHaveProperty("generateAudio");
  const on = composerReducer(INITIAL_COMPOSER, { type: "pick", value: { generateAudio: true } });
  expect(composerSettings(CINEMA_ROW, "16:9", on.picks)).toMatchObject({ generateAudio: true });
  /* Only Cinema Studio on this workspace's credits has the switch; elsewhere the pick is ignored, never sent. */
  expect(soundOffered(CINEMA_ROW)).toBe(true);
  for (const other of [SEEDANCE_ROW, { ...CINEMA_ROW, connected: true as const }, { ...CINEMA_ROW, type: "image" as const }, null]) {
    expect(soundOffered(other), JSON.stringify(other)).toBe(false);
    if (other) expect(composerSettings(other, "16:9", on.picks)).not.toHaveProperty("generateAudio");
  }
  /* Off again, a reset and a new composer all leave it off. */
  expect(composerSettings(CINEMA_ROW, "16:9", composerReducer(on, { type: "pick", value: { generateAudio: false } }).picks)).not.toHaveProperty("generateAudio");
  expect(composerReducer(on, { type: "reset" }).picks).toEqual({});
  /* Choosing another engine and back keeps the choice, as every pick is kept. */
  const away = composerReducer(composerReducer(on, { type: "model", value: SEEDANCE }), { type: "model", value: CINEMA_STUDIO_MODEL_ID });
  expect(composerSettings(CINEMA_ROW, "16:9", away.picks)).toMatchObject({ generateAudio: true });

  /* The price's key: on is another request (priced and approved again); off, the key is exactly what it always was. */
  const key = (picks: { generateAudio?: boolean }) => quoteKeyFor({ billing: "workspace", type: "video", modelId: CINEMA_STUDIO_MODEL_ID,
    settings: composerSettings(CINEMA_ROW, "16:9", picks), references: [], prompt: "a wave", seconds: 10, instrumental: true, voiceId: "" });
  expect(key({ generateAudio: true })).not.toBe(key({}));
  expect(key({})).toBe(JSON.stringify(["workspace", "video", CINEMA_STUDIO_MODEL_ID, "16:9", "720p", 5, "", [], "", 10, true, ""]));
  expect(key({ generateAudio: false })).toBe(key({}));

  /* The request: generateAudio only when the switch is on, and only on a video take. */
  const request = { prompt: "a wave", kind: "video" as const, model: { id: CINEMA_STUDIO_MODEL_ID }, mapping: { shotId: "s", productionProjectId: "p" }, ratio: "16:9", resolution: "720p", duration: 5, references: [] };
  expect(generationRequestBody({ ...request, generateAudio: true })).toMatchObject({ generateAudio: true, model: CINEMA_STUDIO_MODEL_ID });
  for (const generateAudio of [undefined, false])
    expect(generationRequestBody({ ...request, generateAudio }), String(generateAudio)).not.toHaveProperty("generateAudio");
  expect(generationRequestBody({ ...request, kind: "image", generateAudio: true })).not.toHaveProperty("generateAudio");
  /* A sound reference is a reference, and nothing more: it does not turn the switch on. */
  expect(generationRequestBody({ ...request, references: [{ uploadId: "room", role: "reference_audio" }] })).not.toHaveProperty("generateAudio");
});

test("Recreate brings a Cinema Studio take's Sound switch back, and the card says when Gen no longer holds it", async () => {
  const { composerReducer, composerSettings, INITIAL_COMPOSER } = await import("../../lib/workspace/composer");
  const { recreatePreset, recipeChips } = await import("../../lib/shell/recipe");
  const take = (model: string, params: Record<string, unknown>) =>
    ({ id: "gen_sound", kind: "video", model, prompt: "p", provider: model === CINEMA_STUDIO_MODEL_ID ? "higgsfield" : "byteplus", task: "generate", params: { ratio: "16:9", resolution: "720p", duration: 5, ...params } }) as never;
  const preset = recreatePreset(take(CINEMA_STUDIO_MODEL_ID, { generateAudio: true }), { name: "Take" });
  const picks = preset.picks ?? {};
  expect(picks).toMatchObject({ generateAudio: true });
  expect(recreatePreset(take(CINEMA_STUDIO_MODEL_ID, { generateAudio: false }), { name: "Take" }).picks).not.toHaveProperty("generateAudio");
  /* Gen has no Sound switch for any other engine: a take from one comes back as Gen will make it. */
  expect(recreatePreset(take(SEEDANCE, { generateAudio: true }), { name: "Take" }).picks).not.toHaveProperty("generateAudio");

  const recreated = composerReducer(INITIAL_COMPOSER, { type: "recipe", value: { type: "video", billing: "workspace", model: CINEMA_STUDIO_MODEL_ID, picks } });
  expect(composerSettings(CINEMA_ROW, "16:9", recreated.picks)).toMatchObject({ generateAudio: true });
  const chip = (model: ComposerModel, picks: { generateAudio?: boolean }) => recipeChips({
    preset, type: "video", billing: "workspace", model, models: [CINEMA_ROW, SEEDANCE_ROW], settings: composerSettings(model, "16:9", picks),
    reading: false, blocked: null, owner: true, identities: null,
  }).find((c) => c.key === "sound");
  expect(chip(CINEMA_ROW, picks)).toEqual({ key: "sound", label: "Sound", value: "With sound", state: "kept" });
  expect(chip(CINEMA_ROW, { generateAudio: false })).toEqual({ key: "sound", label: "Sound", value: "With sound → silent", state: "changed", why: "Changed here" });
  expect(chip(SEEDANCE_ROW, picks)).toMatchObject({ state: "changed", why: "Seedance 2.5 has no Sound switch here" });
  /* A silent take says nothing about sound. */
  expect(recipeChips({ preset: recreatePreset(take(CINEMA_STUDIO_MODEL_ID, {}), { name: "Take" }), type: "video", billing: "workspace", model: CINEMA_ROW,
    models: [CINEMA_ROW], settings: composerSettings(CINEMA_ROW, "16:9", {}), reading: false, blocked: null, owner: true, identities: null }).some((c) => c.key === "sound")).toBe(false);
});

test("a saved node remembers its Sound switch only as yes or no", async () => {
  const { moleculrSchema } = await import("../../lib/workbench/studio-schema");
  const { EMPTY_MOLECULR } = await import("../../lib/workbench/moleculr");
  const brief = (generateAudio: unknown) => ({ ...EMPTY_MOLECULR, variants: [{ id: "v1", nodeId: "n1", hook: "", generation: { modelId: CINEMA_STUDIO_MODEL_ID, generateAudio } }] });
  for (const value of [true, false, undefined]) expect(moleculrSchema.safeParse(brief(value)).success, String(value)).toBe(true);
  for (const bad of ["true", 1, null, { on: true }]) expect(moleculrSchema.safeParse(brief(bad)).success, JSON.stringify(bad)).toBe(false);
});

/* ── The provider is always told, and a sound reference never turns it on ── */

test("the provider is told generate_audio: false unless the switch is on, with or without a sound reference", async () => {
  const { cinemaStudioInput } = await import("../../lib/cinemaStudio");
  for (const generateAudio of [false, undefined]) {
    const body = await cinemaStudioInput("A keeper hums to @Audio1", settings({ generateAudio }), [wav("room")]) as Record<string, unknown>;
    /* Said, never left out: left out, the provider's own default (sound on) would decide. */
    expect(body, String(generateAudio)).toHaveProperty("generate_audio", false);
    expect(body.audio_urls).toEqual([expect.stringMatching(/uploads\/room\.wav$/)]);
    expect(body.prompt).toBe("A keeper hums to <<<audio_1>>>");
  }
  expect(await cinemaStudioInput("A keeper hums", settings({ generateAudio: true }), [])).toHaveProperty("generate_audio", true);
  expect(await cinemaStudioInput("A keeper hums to @Audio1", settings({ generateAudio: true }), [wav("room")])).toMatchObject({ generate_audio: true, audio_urls: [expect.any(String)] });
});

test("dispatch sends the switch exactly as the take was approved: false when off, true when on, in its one POST", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("cinema_sound_dispatch"), async () => {
    const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
    const { getModel } = await import("../../lib/models"), { getTask } = await import("../../lib/tasks");
    const { higgsfield } = await import("../../lib/engines/higgsfield"), { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
    process.env.ENGINE_MOCK = "0";
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ request_id: requestId, status: "queued", status_url: statusUrl, cancel_url: cancelUrl });
    };
    for (const generateAudio of [false, true]) {
      const params: VideoParams = { ...settings({ generateAudio }), higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: cinemaStudioQuoteUsd(settings())! };
      const req: VideoRenderRequest = { kind: "video", genId: `gen_sound_${generateAudio}`, model: getModel(CINEMA_STUDIO_MODEL_ID), task: getTask("generate"), prompt: "A harbour at dawn", params, references: [], source: null };
      /* The approved figure is the same either way, so the re-price lets it go. */
      expect(cinemaStudioQuoteUsd(params)).toBe(params.higgsfieldVendorCostUsd);
      await expect(higgsfield.render(req)).resolves.toMatchObject({ handle: { ref: requestId } });
    }
    expect(calls.map((c) => [c.url, c.body.generate_audio])).toEqual([
      ["https://api.higgsfield.ai/higgsfield/cinema-studio/4.0", false],
      ["https://api.higgsfield.ai/higgsfield/cinema-studio/4.0", true],
    ]);
  }, actor);
});

/* ── The price: the published formula, with the switch on or off ──────── */

test("the quote is the published formula's with the switch on or off; engines that bill sound by the second still do", async () => {
  const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
  const { quoteWorkbenchMedia, NO_REFERENCES } = await import("../../lib/workbench/media-quote");
  const { getModel } = await import("../../lib/models");
  for (const patch of [{}, { resolution: "480p", ratio: "9:16", duration: 30 }, { hasVideoInput: true, inputSeconds: 4 }] as Partial<VideoParams>[]) {
    const silent = cinemaStudioQuoteUsd(settings({ ...patch, generateAudio: false }));
    expect(silent, JSON.stringify(patch)).toBeGreaterThan(0);
    expect(cinemaStudioQuoteUsd(settings({ ...patch, generateAudio: true })), JSON.stringify(patch)).toBe(silent);
  }
  const cinema = getModel(CINEMA_STUDIO_MODEL_ID), kling = getModel(KLING);
  const at = { resolution: "720p", ratio: "16:9", duration: 5 };
  expect(quoteWorkbenchMedia(cinema, { ...at, audio: true }, NO_REFERENCES)).toEqual(quoteWorkbenchMedia(cinema, at, NO_REFERENCES));
  /* The same read prices sound where an engine bills it: Kling's per-second rate with sound is its own. */
  const klingAt = { resolution: "1080p", ratio: "16:9", duration: 5 };
  expect(quoteWorkbenchMedia(kling, { ...klingAt, audio: true }, NO_REFERENCES).credits!).toBeGreaterThan(quoteWorkbenchMedia(kling, klingAt, NO_REFERENCES).credits!);
});

test("the composer's price read takes the switch, answers in credits only, and gives Cinema Studio the same approximate figure", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const route = load<{ GET(request: Request): Promise<Response> }>("app/api/workbench/engines/route.ts", {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireUser: async () => ({ user: actor.user }) },
  });
  await runInTenant(workspace("cinema_sound_read"), async () => {
    const read = async (model: string, query: string) => {
      const reply = await route.GET(new Request(`http://localhost/api/workbench/engines?model=${encodeURIComponent(model)}&${query}`));
      expect(reply.status, query).toBe(200);
      return reply.json() as Promise<{ credits: number; approximate?: boolean } & Record<string, unknown>>;
    };
    const silent = await read(CINEMA_STUDIO_MODEL_ID, "resolution=720p&ratio=16:9&duration=5");
    const loud = await read(CINEMA_STUDIO_MODEL_ID, "resolution=720p&ratio=16:9&duration=5&audio=1");
    expect(silent.credits).toBeGreaterThan(0);
    expect(loud).toMatchObject({ credits: silent.credits, approximate: true });
    /* The read honours the switch: an engine that bills sound answers its own figure for it. */
    const klingSilent = await read(KLING, "resolution=1080p&ratio=16:9&duration=5"), klingLoud = await read(KLING, "resolution=1080p&ratio=16:9&duration=5&audio=1");
    expect(klingLoud.credits).toBeGreaterThan(klingSilent.credits);
    /* Credits only: the reply names no dollars, rates or vendor figures. */
    for (const reply of [silent, loud]) expect(Object.keys(reply).sort()).toEqual(["approximate", "credits", "hasVideoInput", "inputSeconds", "models"]);
  }, actor);
});

test("the watched pricing text is the one the quote prices from, and it names no charge for sound", async () => {
  const { VENDOR_RATES } = await import("../../lib/vendorRates");
  const { CINEMA_STUDIO_PRICING_WATCH } = await import("../../lib/cinemaStudio");
  const { pricingDescriptionSha256 } = await import("../../lib/higgsfieldPricingWatch");
  /* The provider's published pricing text, rebuilt from the rates the quote uses (no figure is written here): if a
     rate or the watched hash moves without the other, this fails; if the provider's text changes (a charge for sound,
     say), the production watch flags it and both are revisited together. */
  const tier = VENDOR_RATES[CINEMA_STUDIO_MODEL_ID].tiers![0];
  const perThousand = (perMillion: number) => String(Number((perMillion / 1000).toPrecision(6)));
  const ratio = String(Number((tier.withVideo / tier.withoutVideo).toPrecision(3)));
  const published = "Token-metered pricing. Billable video tokens = ceil((input video seconds + generated video seconds) × output width × output height × 24 fps / 1024). " +
    "Image and audio references do not count as video input. " +
    `At ${tier.resolutions.join(" or ")}, each 1,000 video tokens cost $${perThousand(tier.withoutVideo)} without video input or $${perThousand(tier.withVideo)} with video input (${ratio}× the standard rate). ` +
    "With video references, both input and generated video durations are billable. Rates shown are before any applicable customer discount.";
  expect(pricingDescriptionSha256(published)).toBe(CINEMA_STUDIO_PRICING_WATCH.expectedSha256);
  /* Sound appears once: audio references are not video input. Nothing in it is billed for sound. */
  expect(published.match(/audio|sound/gi)).toEqual(["audio"]);
});

/* ── Admission, through the real /api/generate route ─────────────────── */

async function fixture(name: string, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, `${name}.db`)}`],
  });
  await grantCredits(name, 100000, "Cinema Studio sound test", actor.user.id, "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  await runInTenant(ws, async () => run(await setup()), actor);
}
async function setup() {
  const database = await import("../../lib/db");
  const higgsfield = await import("../../lib/higgsfield");
  await database.ready();
  await database.db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Saved production',0)");
  await database.db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0)");
  const dispatches: string[] = [];
  const admission = load<typeof import("../../lib/generationAdmission")>("lib/generationAdmission.ts", {
    "@/lib/inngest": { enqueueRender: async (id: string) => { dispatches.push(id); return true; } },
    "@/lib/higgsfield": { ...higgsfield, higgsfieldCredentialFingerprint: () => "c".repeat(64) },
  });
  const handler = load<{ POST(request: Request): Promise<Response> }>("app/api/generate/route.ts", {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireRender: async () => actor },
    "@/lib/generationAdmission": admission,
    "next/server": { after: () => { throw new Error("The acknowledged test queue must not run a provider worker."); } },
  });
  async function upload(id: string, seconds: number) {
    await database.db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,'audio/wav','wav',128,'fixture-sha',?,'audio',?,0)",
      args: [id, id, `/api/uploads/${id}`, seconds],
    });
    return { uploadId: id, role: "reference_audio" };
  }
  /* What Gen and the dialog send with the switch off: no generateAudio at all. */
  const body = (patch: Record<string, unknown> = {}) => ({ model: CINEMA_STUDIO_MODEL_ID, prompt: "A lighthouse keeper waits on the pier", ratio: "16:9", resolution: "720p", duration: 5, projectId: "project", refine: false, ...patch });
  const post = (value: Record<string, unknown>, key: string) => handler.POST(new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value) }));
  const rows = async () => (await database.db().execute({ sql: "SELECT * FROM generations WHERE model=?", args: [CINEMA_STUDIO_MODEL_ID] })).rows;
  return { admission, upload, body, post, rows, dispatches };
}
function prepared(result: PrepareAdmissionResult): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const params = (p: PreparedAdmission) => p.compiled.params as VideoParams;

test("admission keeps a take silent unless the switch is on, a sound reference never turns it on, and the approval is bound to it at the same price", async () => fixture("cinema_sound_admission", async (f) => {
  const silent = prepared(await f.admission.prepareGeneration(f.body(), actor));
  expect(params(silent).generateAudio).toBe(false);
  expect(prepared(await f.admission.prepareGeneration(f.body({ generateAudio: false }), actor)).quote.fingerprint).toBe(silent.quote.fingerprint);
  const loud = prepared(await f.admission.prepareGeneration(f.body({ generateAudio: true }), actor));
  expect(params(loud).generateAudio).toBe(true);
  /* The same approximate figure (the published formula has no term for sound), and another approval. */
  expect(loud.quote).toMatchObject({ approximate: true, estimatedCredits: silent.quote.estimatedCredits });
  expect(params(loud).higgsfieldVendorCostUsd).toBe(params(silent).higgsfieldVendorCostUsd);
  expect(loud.quote.fingerprint).not.toBe(silent.quote.fingerprint);
  /* A WAV reference with the switch off: cited, sent, and still silent. */
  const room = await f.upload("room", 6);
  const referenced = prepared(await f.admission.prepareGeneration(f.body({ prompt: "A keeper hums to @Audio1", references: [room] }), actor));
  expect(params(referenced).generateAudio).toBe(false);
  expect((referenced.compiled.references as Reference[]).map((r) => [r.id, r.role])).toEqual([["room", "reference_audio"]]);
  expect(referenced.quote.estimatedCredits).toBe(silent.quote.estimatedCredits);

  /* An approval given with the switch off is not one for sound: refused, nothing kept, nothing dispatched. */
  const swapped = await f.post({ ...f.body({ generateAudio: true }), maxCredits: silent.quote.estimatedCredits, quoteFingerprint: silent.quote.fingerprint }, "cinema-sound-swapped");
  expect(swapped.status, await swapped.text()).toBe(409);
  expect(await f.rows()).toEqual([]);
  /* Approved with sound: accepted once, with the switch on the row and the quote it was approved at. */
  const accepted = await f.post({ ...f.body({ generateAudio: true }), maxCredits: loud.quote.estimatedCredits, quoteFingerprint: loud.quote.fingerprint }, "cinema-sound-once");
  const result = await accepted.json();
  expect(accepted.status, JSON.stringify(result)).toBe(202);
  expect(f.dispatches).toEqual([result.id]);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0].params))).toMatchObject({ generateAudio: true, higgsfieldVendorCostUsd: params(silent).higgsfieldVendorCostUsd });
}));

/* ── Movement on Auto: the camera is the model's ─────────────────────── */

test("Movement on Auto writes no camera sentence; a picked movement goes as its parameter; every other engine keeps its camera module", async () => fixture("cinema_sound_camera", async (f) => {
  const { hasCameraModule, moduleFor } = await import("../../lib/studio");
  const { cinemaStudioInput } = await import("../../lib/cinemaStudio");
  const waits = "A lighthouse keeper waits on the pier";
  const named = "Handheld, a lighthouse keeper walks the pier";
  /* Auto: nothing named, nothing inferred, nothing expanded. The words are the person's own, as typed. */
  for (const words of [waits, named]) {
    const auto = prepared(await f.admission.prepareGeneration(f.body({ prompt: words }), actor));
    expect(hasCameraModule(String(auto.compiled.prompt)), words).toBe(false);
    expect(auto.compiled.prompt).toBe(words);
    expect(params(auto)).not.toHaveProperty("cinema");
    /* And the provider is given no movement: the model chooses. */
    expect(await cinemaStudioInput(String(auto.compiled.prompt), params(auto), [])).not.toHaveProperty("camera_movement");
  }
  /* Other controls picked, movement on Auto: still no camera sentence. */
  expect(prepared(await f.admission.prepareGeneration(f.body({ prompt: waits, cinema: { genre: "noir", pacing: "calm" } }), actor)).compiled.prompt).toBe(waits);
  /* A picked movement: sent as camera_movement, never as words. */
  const picked = prepared(await f.admission.prepareGeneration(f.body({ prompt: waits, cinema: { camera_movement: "dolly-in" } }), actor));
  expect(picked.compiled.prompt).toBe(waits);
  expect(params(picked).cinema).toEqual({ camera_movement: "dolly-in" });
  expect(await cinemaStudioInput(String(picked.compiled.prompt), params(picked), [])).toMatchObject({ prompt: waits, camera_movement: "dolly-in" });

  /* Every other engine is as it was: a move named in the words is expanded, and one is read off the action otherwise. */
  const seedance = async (prompt: string) => prepared(await f.admission.prepareGeneration(f.body({ model: SEEDANCE, prompt }), actor));
  const inferred = String((await seedance(waits)).compiled.prompt);
  expect(hasCameraModule(inferred)).toBe(true);
  expect(inferred).toContain(moduleFor("move", "static"));
  const expanded = String((await seedance(named)).compiled.prompt);
  expect(expanded).toContain(moduleFor("move", "handheld"));
}));
