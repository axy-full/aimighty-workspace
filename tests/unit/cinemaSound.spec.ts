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
import type { ComposerModel, EngineRow } from "../../lib/workspace/composer";
import { CINEMA_STUDIO_MODEL_ID } from "../../lib/cinemaStudioTypes";
import { HOUSE_WORKSPACE_ID } from "../../lib/houseWorkspace";

/**
 * Cinema Studio 4.0's Sound switch, its private price, and its Movement on Auto.
 *
 * - What sound costs is set privately, in the environment (lib/cinemaSoundPricing.ts), and read strictly: anything
 *   it does not fully understand counts as unset. Every price below is a fixture, not the real pricing.
 * - Unset, the switch is offered only in the house workspace (by its id, never by the legacy flag), which is metered at
 *   cost. Everywhere else it is hidden, and admission refuses a take asked for with sound, before anything is reserved
 *   or sent.
 * - Set, the switch is offered everywhere and sound is part of the price wherever the price is made: the quote, the
 *   credit ceiling, the re-price before dispatch and the settlement, through the same credit terms.
 * - A request carries `generateAudio` only when the switch is on; a sound reference never turns it on. The provider
 *   is always told `generate_audio` (its own default is sound on): false unless the switch is on.
 * - The switch is in the price's key and in the approval's fingerprint.
 * - Movement on Auto writes no camera sentence: the camera is the model's to choose. A picked movement goes as its own
 *   parameter, and every other engine's camera module is as it was.
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
const UNAVAILABLE = "Sound isn't available for Cinema Studio yet.";
/** The private setting, and fixture values for it: not the real pricing. */
const PRICING = "HF_CINEMA_STUDIO_SOUND_PRICING";
const PER_TAKE = JSON.stringify({ perTakeUsd: 0.5 });
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
  delete process.env[PRICING];
  process.env.ENGINE_MOCK = "1";
  process.env.HF_CREDENTIALS = "fixture:key";
  globalThis.fetch = async () => { throw new Error("External network forbidden"); };
});
test.afterEach(() => { globalThis.fetch = originalFetch; process.env.ENGINE_MOCK = "1"; delete process.env[PRICING]; });

const settings = (patch: Partial<VideoParams> = {}): VideoParams =>
  ({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, generateAudio: false, hasVideoInput: false, ...patch });
const wav = (id: string): Reference => ({ id, kind: "audio", mime: "audio/wav", ext: "wav", storedUrl: `/api/uploads/${id}`, role: "reference_audio" });
/** Gen's model rows, as the composer holds them: Cinema Studio where its sound is offered, and where it is not. */
const CINEMA_ROW: ComposerModel = { id: CINEMA_STUDIO_MODEL_ID, label: "Cinema Studio 4.0", type: "video", ratios: ["16:9", "9:16"], resolutions: ["720p", "480p"], durations: [4, 5, 6], sound: true };
const CINEMA_SILENT_ROW: ComposerModel = { ...CINEMA_ROW, sound: undefined };
const SEEDANCE_ROW: ComposerModel = { id: SEEDANCE, label: "Seedance 2.5", type: "video", ratios: ["16:9"], resolutions: ["720p"], durations: [5] };

function workspace(name: string, legacy = false): TenantWorkspace {
  return { id: name, slug: name, name, legacy, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 20, rendersPerHour: 200, storageQuotaBytes: null, deletedAt: null };
}

/* ── The private price: read strictly ────────────────────────────────── */

test("the sound price is read strictly from the environment: one or more of three known terms, each in range; anything else is unset", async () => {
  const { parseCinemaSoundPricing, cinemaSoundPricing } = await import("../../lib/cinemaSoundPricing");
  /* Each term on its own (the others change nothing), together, and spaced. */
  expect(parseCinemaSoundPricing('{"multiplier":1.5}')).toEqual({ multiplier: 1.5, perSecondUsd: 0, perTakeUsd: 0 });
  expect(parseCinemaSoundPricing('{"perSecondUsd":0.1}')).toEqual({ multiplier: 1, perSecondUsd: 0.1, perTakeUsd: 0 });
  expect(parseCinemaSoundPricing(PER_TAKE)).toEqual({ multiplier: 1, perSecondUsd: 0, perTakeUsd: 0.5 });
  expect(parseCinemaSoundPricing(' { "multiplier": 1.2, "perSecondUsd": 0.05, "perTakeUsd": 0.25 } ')).toEqual({ multiplier: 1.2, perSecondUsd: 0.05, perTakeUsd: 0.25 });
  /* No change at all is a price too: sound measured at nothing extra. */
  expect(parseCinemaSoundPricing('{"multiplier":1}')).toEqual({ multiplier: 1, perSecondUsd: 0, perTakeUsd: 0 });
  /* Anything it does not fully understand counts as unset. */
  for (const raw of [undefined, null, 7, "", "   ", "not json", "[]", "null", "1", '"perTakeUsd"', "{}", '{"multiplier":0.9}', '{"multiplier":4.5}',
    '{"perSecondUsd":-0.01}', '{"perSecondUsd":1.5}', '{"perTakeUsd":12}', '{"perTakeUsd":"0.5"}', '{"multiplier":null}', '{"multiplier":true}',
    '{"multiplier":1e400}', '{"multiplier":1,"surcharge":1}', '{"__proto__":{"multiplier":2}}', '{"constructor":1}', '[{"perTakeUsd":0.5}]',
    `{"perTakeUsd":0.5${" ".repeat(200)}}`])
    expect(parseCinemaSoundPricing(raw), JSON.stringify(raw)).toBeNull();
  /* From the environment: unset is unset, and a value it cannot read is said once in the log, without the value. */
  expect(cinemaSoundPricing()).toBeNull();
  process.env[PRICING] = PER_TAKE;
  expect(cinemaSoundPricing()).toEqual({ multiplier: 1, perSecondUsd: 0, perTakeUsd: 0.5 });
  const warnings: string[] = [], warn = console.warn;
  console.warn = (line: string) => { warnings.push(line); };
  try {
    process.env[PRICING] = '{"perTakeUsd":"0.75"}';
    expect(cinemaSoundPricing()).toBeNull();
    expect(cinemaSoundPricing()).toBeNull();
  } finally { console.warn = warn; }
  expect(warnings).toHaveLength(1);
  expect(JSON.parse(warnings[0])).toEqual({ level: "warn", event: "cinema.sound_pricing_invalid", env: PRICING });
  expect(warnings[0]).not.toContain("0.75");
});

test("where sound is offered: anywhere once it is priced, always in the house workspace (by its id), nowhere else", async () => {
  const { cinemaSoundOffered } = await import("../../lib/cinemaSoundPricing");
  /* The house is named by its id; a workspace that only carries the legacy flag is not the house, and fails closed. */
  const credits = workspace("on_credits"), house = workspace(HOUSE_WORKSPACE_ID, true), flagged = workspace("flagged_not_house", true);
  expect([credits, house, flagged, null].map(cinemaSoundOffered)).toEqual([false, true, false, false]);
  process.env[PRICING] = '{"perTakeUsd":"wrong"}';
  expect([credits, house, flagged].map(cinemaSoundOffered)).toEqual([false, true, false]);
  process.env[PRICING] = PER_TAKE;
  expect([credits, house, flagged, null].map(cinemaSoundOffered)).toEqual([true, true, true, true]);
});

/* ── What sound adds to a take ───────────────────────────────────────── */

test("sound adds its measured charge to the quote and the delivered figure: the generated seconds' tokens times the multiplier, a fee per second, a fee per take, never the reference clip's seconds", async () => {
  const { cinemaStudioQuoteUsd, cinemaStudioDeliveredUsd, cinemaStudioSettlementUsd } = await import("../../lib/cinemaStudio");
  const { estimateCostUsd } = await import("../../lib/vendorPricing");
  const quote = (patch: Partial<VideoParams>) => cinemaStudioQuoteUsd(settings(patch))!;
  const output = (patch: Partial<VideoParams>) => estimateCostUsd(CINEMA_STUDIO_MODEL_ID, "720p", "16:9", patch.duration ?? 5, 0, Boolean(patch.hasVideoInput))!.net;
  const clip = { hasVideoInput: true, inputSeconds: 4 };
  /* Unset (the house workspace's case): sound adds nothing that is known. */
  for (const patch of [{}, { duration: 10 }, clip]) expect(quote({ ...patch, generateAudio: true }), JSON.stringify(patch)).toBe(quote(patch));
  /* A fee per take. */
  process.env[PRICING] = PER_TAKE;
  for (const patch of [{}, { duration: 10 }, clip]) expect(quote({ ...patch, generateAudio: true }), JSON.stringify(patch)).toBeCloseTo(quote(patch) + 0.5, 10);
  /* A fee per generated second. */
  process.env[PRICING] = JSON.stringify({ perSecondUsd: 0.1 });
  expect(quote({ generateAudio: true })).toBeCloseTo(quote({}) + 0.5, 10);
  expect(quote({ duration: 10, generateAudio: true })).toBeCloseTo(quote({ duration: 10 }) + 1, 10);
  /* By the token: the generated seconds' cost scales, the reference clip's seconds do not. */
  process.env[PRICING] = JSON.stringify({ multiplier: 1.5 });
  expect(quote({ generateAudio: true })).toBeCloseTo(quote({}) * 1.5, 10);
  expect(quote({ ...clip, generateAudio: true })).toBeCloseTo(quote(clip) + 0.5 * output(clip), 10);
  expect(quote({ ...clip, generateAudio: true })).toBeLessThan(quote(clip) * 1.5);
  /* All three together. */
  process.env[PRICING] = JSON.stringify({ multiplier: 1.2, perSecondUsd: 0.05, perTakeUsd: 0.25 });
  expect(quote({ generateAudio: true })).toBeCloseTo(quote({}) + 0.2 * output({}) + 0.25 + 0.25, 10);
  /* A silent take is never touched. */
  expect(quote({ generateAudio: false })).toBe(quote({}));

  /* The settlement on the delivered output carries the same addition, on the seconds actually delivered. */
  process.env[PRICING] = JSON.stringify({ perSecondUsd: 0.1 });
  const delivered = { resolution: "720p", width: 1280, height: 720, seconds: 5.04 };
  const silentDelivered = cinemaStudioDeliveredUsd(delivered)!;
  const loudDelivered = cinemaStudioDeliveredUsd({ ...delivered, generateAudio: true })!;
  expect(loudDelivered).toBeCloseTo(silentDelivered + 0.504, 10);
  expect(cinemaStudioSettlementUsd(quote({ generateAudio: true }), loudDelivered, null)).toBe(loudDelivered);
  delete process.env[PRICING];
  expect(cinemaStudioDeliveredUsd({ ...delivered, generateAudio: true })).toBe(silentDelivered);
});

/* ── Gen and the canvas dialog: offered where sound is, off by default ─ */

test("the Sound switch is off by default, offered only where the engines route says Cinema Studio's sound is, and a request carries generateAudio only when it is on", async () => {
  const { composerReducer, composerSettings, quoteKeyFor, soundOffered, workspaceModels, INITIAL_COMPOSER } = await import("../../lib/workspace/composer");
  const { generationRequestBody } = await import("../../lib/workbench/generation-request");
  /* The engines route's flag becomes the row's: only on Cinema Studio's video row. */
  const engine: EngineRow = { id: CINEMA_STUDIO_MODEL_ID, kind: "video", resolutions: ["720p"], ratios: ["16:9"], durations: [5] };
  expect(workspaceModels([{ ...engine, sound: true }], null)[0]).toMatchObject({ id: CINEMA_STUDIO_MODEL_ID, sound: true });
  expect(workspaceModels([engine], null)[0]).not.toHaveProperty("sound");
  expect(workspaceModels([{ ...engine, kind: "image", sound: true }], null)[0]).not.toHaveProperty("sound");
  /* Off until it is turned on. */
  expect(INITIAL_COMPOSER.picks).toEqual({});
  expect(composerSettings(CINEMA_ROW, "16:9", INITIAL_COMPOSER.picks)).not.toHaveProperty("generateAudio");
  const on = composerReducer(INITIAL_COMPOSER, { type: "pick", value: { generateAudio: true } });
  expect(composerSettings(CINEMA_ROW, "16:9", on.picks)).toMatchObject({ generateAudio: true });
  /* Offered only on Cinema Studio where its sound is; elsewhere the pick is ignored, never sent. */
  expect(soundOffered(CINEMA_ROW)).toBe(true);
  for (const other of [CINEMA_SILENT_ROW, SEEDANCE_ROW, { ...SEEDANCE_ROW, sound: true as const }, { ...CINEMA_ROW, connected: true as const }, { ...CINEMA_ROW, type: "image" as const }, null]) {
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
  const key = (picks: { generateAudio?: boolean }, row = CINEMA_ROW) => quoteKeyFor({ billing: "workspace", type: "video", modelId: CINEMA_STUDIO_MODEL_ID,
    settings: composerSettings(row, "16:9", picks), references: [], prompt: "a wave", seconds: 10, instrumental: true, voiceId: "" });
  expect(key({ generateAudio: true })).not.toBe(key({}));
  expect(key({})).toBe(JSON.stringify(["workspace", "video", CINEMA_STUDIO_MODEL_ID, "16:9", "720p", 5, "", [], "", 10, true, ""]));
  expect(key({ generateAudio: false })).toBe(key({}));
  expect(key({ generateAudio: true }, CINEMA_SILENT_ROW)).toBe(key({}));

  /* The request: generateAudio only when the switch is on, and only on a video take. */
  const request = { prompt: "a wave", kind: "video" as const, model: { id: CINEMA_STUDIO_MODEL_ID }, mapping: { shotId: "s", productionProjectId: "p" }, ratio: "16:9", resolution: "720p", duration: 5, references: [] };
  expect(generationRequestBody({ ...request, generateAudio: true })).toMatchObject({ generateAudio: true, model: CINEMA_STUDIO_MODEL_ID });
  for (const generateAudio of [undefined, false])
    expect(generationRequestBody({ ...request, generateAudio }), String(generateAudio)).not.toHaveProperty("generateAudio");
  expect(generationRequestBody({ ...request, kind: "image", generateAudio: true })).not.toHaveProperty("generateAudio");
  /* A sound reference is a reference, and nothing more: it does not turn the switch on. */
  expect(generationRequestBody({ ...request, references: [{ uploadId: "room", role: "reference_audio" }] })).not.toHaveProperty("generateAudio");
});

test("the model sheet prices a row with sound only when Gen's switch is on, so the picked row's figure is still Generate's", async () => {
  const { rateQuery, needsPricedRead, rowPrice, UNTOUCHED } = await import("../../lib/workspace/model-picker");
  const at = { ...UNTOUCHED, picks: { generateAudio: true } };
  expect(new URLSearchParams(rateQuery(at)).get("pickSound")).toBe("1");
  expect(new URLSearchParams(rateQuery(UNTOUCHED)).has("pickSound")).toBe(false);
  const silentRate = { credits: 31, resolution: "720p", ratio: "16:9", duration: 5, approximate: true as const };
  const loudRate = { ...silentRate, credits: 36, sound: true as const };
  /* The list's own rate is for a silent take: with the switch on it no longer fits, so the sheet asks again. */
  expect(needsPricedRead([{ ...CINEMA_ROW, rate: silentRate }], UNTOUCHED)).toBe(false);
  expect(needsPricedRead([{ ...CINEMA_ROW, rate: silentRate }], at)).toBe(true);
  expect(needsPricedRead([{ ...CINEMA_ROW, rate: loudRate }], at)).toBe(false);
  /* Where the switch is not offered, the pick is ignored and the silent rate still fits. */
  expect(needsPricedRead([{ ...CINEMA_SILENT_ROW, rate: silentRate }], at)).toBe(false);
  /* The sheet's priced read answers with sound: that figure is the row's. */
  const sheet = { key: rateQuery(at), models: { [CINEMA_STUDIO_MODEL_ID]: loudRate }, audio: null };
  expect(rowPrice({ ...CINEMA_ROW, rate: silentRate }, {}, at, sheet)).toMatchObject({ credits: 36, kind: "rate", approximate: true });
});

test("Recreate brings a Cinema Studio take's Sound switch back where sound is offered, and the card says why when it cannot", async () => {
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
    preset, type: "video", billing: "workspace", model, models: [model, SEEDANCE_ROW], settings: composerSettings(model, "16:9", picks),
    reading: false, blocked: null, owner: true, identities: null,
  }).find((c) => c.key === "sound");
  expect(chip(CINEMA_ROW, picks)).toEqual({ key: "sound", label: "Sound", value: "With sound", state: "kept" });
  expect(chip(CINEMA_ROW, { generateAudio: false })).toEqual({ key: "sound", label: "Sound", value: "With sound → silent", state: "changed", why: "Changed here" });
  /* Where the switch is not offered, the take comes back silent and the card says so. */
  expect(composerSettings(CINEMA_SILENT_ROW, "16:9", recreated.picks)).not.toHaveProperty("generateAudio");
  expect(chip(CINEMA_SILENT_ROW, picks)).toEqual({ key: "sound", label: "Sound", value: "With sound → silent", state: "changed", why: "Cinema Studio 4.0 has no Sound switch here" });
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

test("dispatch re-prices with sound before its one POST: sent as approved, and refused when the sound price moved since", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("cinema_sound_dispatch"), async () => {
    const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
    const { getModel } = await import("../../lib/models"), { getTask } = await import("../../lib/tasks");
    const { higgsfield } = await import("../../lib/engines/higgsfield"), { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
    process.env.ENGINE_MOCK = "0";
    process.env[PRICING] = PER_TAKE;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ request_id: requestId, status: "queued", status_url: statusUrl, cancel_url: cancelUrl });
    };
    const request = (generateAudio: boolean): VideoRenderRequest => {
      const params: VideoParams = { ...settings({ generateAudio }), higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: cinemaStudioQuoteUsd(settings({ generateAudio }))! };
      return { kind: "video", genId: `gen_sound_${generateAudio}`, model: getModel(CINEMA_STUDIO_MODEL_ID), task: getTask("generate"), prompt: "A harbour at dawn", params, references: [], source: null };
    };
    const silent = request(false), loud = request(true);
    /* Approved with sound at the price sound adds; the re-price agrees, so each goes, said exactly as approved. */
    expect(loud.params.higgsfieldVendorCostUsd!).toBeCloseTo(silent.params.higgsfieldVendorCostUsd! + 0.5, 10);
    for (const req of [silent, loud]) await expect(higgsfield.render(req)).resolves.toMatchObject({ handle: { ref: requestId } });
    expect(calls.map((c) => [c.url, c.body.generate_audio])).toEqual([
      ["https://api.higgsfield.ai/higgsfield/cinema-studio/4.0", false],
      ["https://api.higgsfield.ai/higgsfield/cinema-studio/4.0", true],
    ]);
    /* The sound price changed (or was taken away) after approval: the take with sound is not sent; a silent one is. */
    for (const changed of [JSON.stringify({ perTakeUsd: 0.75 }), undefined]) {
      if (changed) process.env[PRICING] = changed; else delete process.env[PRICING];
      await expect(higgsfield.render(loud), String(changed)).rejects.toMatchObject({ status: 422 });
      await expect(higgsfield.render(silent), String(changed)).resolves.toMatchObject({ handle: { ref: requestId } });
    }
    expect(calls.map((c) => c.body.generate_audio)).toEqual([false, true, false, false]);
  }, actor);
});

/* ── The price read: offered and priced only where sound is, credits only ── */

test("the composer's price read: sound is offered and priced only where it is, refused elsewhere, and answered in credits only", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const route = load<{ GET(request: Request): Promise<Response> }>("app/api/workbench/engines/route.ts", {
    "@/lib/auth": { withTenant: (h: unknown) => h, requireUser: async () => ({ user: actor.user }) },
  });
  const read = async (query: string) => route.GET(new Request(`http://localhost/api/workbench/engines?${query}`));
  const priced = async (model: string, query: string) => {
    const reply = await read(`model=${encodeURIComponent(model)}&${query}`);
    expect(reply.status, query).toBe(200);
    return reply.json() as Promise<{ credits: number; approximate?: boolean } & Record<string, unknown>>;
  };
  type Row = { id: string; sound?: boolean; rate?: { credits: number; sound?: boolean } | null };
  const cinemaRow = async (query = "") => ((await (await read(query)).json()).models as Row[]).find((row) => row.id === CINEMA_STUDIO_MODEL_ID)!;
  const at = "resolution=720p&ratio=16:9&duration=5";

  /* Unset, on a workspace's credits: no switch, and a read for sound is refused with the reason. */
  await runInTenant(workspace("cinema_sound_read"), async () => {
    expect(await cinemaRow()).not.toHaveProperty("sound");
    expect((await cinemaRow("pickSound=1")).rate).not.toHaveProperty("sound");
    const silent = await priced(CINEMA_STUDIO_MODEL_ID, at);
    expect(silent.credits).toBeGreaterThan(0);
    const refused = await read(`model=${encodeURIComponent(CINEMA_STUDIO_MODEL_ID)}&${at}&audio=1`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: UNAVAILABLE });
  }, actor);
  /* Unset, a workspace that only carries the legacy flag is not the house: no switch, and sound is refused. */
  await runInTenant(workspace("cinema_sound_read_flagged", true), async () => {
    expect(await cinemaRow()).not.toHaveProperty("sound");
    const refused = await read(`model=${encodeURIComponent(CINEMA_STUDIO_MODEL_ID)}&${at}&audio=1`);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: UNAVAILABLE });
  }, actor);
  /* Unset, in the house workspace: offered, at what is known (nothing added). */
  await runInTenant(workspace(HOUSE_WORKSPACE_ID, true), async () => {
    expect(await cinemaRow()).toMatchObject({ sound: true });
    const silent = await priced(CINEMA_STUDIO_MODEL_ID, at), loud = await priced(CINEMA_STUDIO_MODEL_ID, `${at}&audio=1`);
    expect(loud).toMatchObject({ credits: silent.credits, approximate: true });
  }, actor);
  /* Set: offered everywhere, and the figure with sound is its own, the same on the sheet's row as on the button. */
  process.env[PRICING] = PER_TAKE;
  await runInTenant(workspace("cinema_sound_read"), async () => {
    expect(await cinemaRow()).toMatchObject({ sound: true });
    const silent = await priced(CINEMA_STUDIO_MODEL_ID, at), loud = await priced(CINEMA_STUDIO_MODEL_ID, `${at}&audio=1`);
    expect(loud.approximate).toBe(true);
    expect(loud.credits).toBeGreaterThan(silent.credits);
    expect((await cinemaRow("pickSound=1&pickResolution=720p&pickDuration=5")).rate).toMatchObject({ credits: loud.credits, sound: true });
    expect((await cinemaRow("pickResolution=720p&pickDuration=5")).rate).toMatchObject({ credits: silent.credits });
    expect((await cinemaRow("pickResolution=720p&pickDuration=5")).rate).not.toHaveProperty("sound");
    /* Credits only: the reply names no dollars, rates or vendor figures. */
    for (const reply of [silent, loud]) expect(Object.keys(reply).sort()).toEqual(["approximate", "credits", "hasVideoInput", "inputSeconds", "models"]);
    /* An engine that bills sound by the second still answers its own figure for it. */
    const klingSilent = await priced(KLING, "resolution=1080p&ratio=16:9&duration=5"), klingLoud = await priced(KLING, "resolution=1080p&ratio=16:9&duration=5&audio=1");
    expect(klingLoud.credits).toBeGreaterThan(klingSilent.credits);
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

async function fixture(name: string, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, legacy = false) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,legacy,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,?,1,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, `${name}.db`)}`, legacy ? 1 : 0],
  });
  /* The house is never given credits; every other workspace pays in them. */
  if (name !== HOUSE_WORKSPACE_ID) await grantCredits(name, 100000, "Cinema Studio sound test", actor.user.id, "manual");
  const ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0]);
  expect(ws.legacy).toBe(legacy);
  await runInTenant(ws, async () => run(await setup(name)), actor);
}
async function setup(name: string) {
  const database = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const higgsfield = await import("../../lib/higgsfield");
  await database.ready();
  /* A workspace with the legacy flag keeps its data in the primary database, so two such fixtures share it. */
  await database.db().execute("INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Saved production',0)");
  await database.db().execute("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('promptWriter','none',0)");
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
  /* What admission reserves: the meter's event and the reservation, on the platform's own books (the reservations'
     table is made with the first reservation anywhere). */
  const reserved = async () => {
    const count = async (table: string) => Number((await platformDb().execute({ sql: `SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id=?`, args: [name] })).rows[0].n);
    const made = (await platformDb().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='generation_reservations'")).rows.length > 0;
    return (await count("meter_events")) + (made ? await count("generation_reservations") : 0);
  };
  return { admission, upload, body, post, rows, reserved, dispatches };
}
function prepared(result: PrepareAdmissionResult): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const params = (p: PreparedAdmission) => p.compiled.params as VideoParams;

test("unset, a take asked for with sound is refused before anything is reserved or sent, however it is asked; a silent take goes as before", async () => fixture("cinema_sound_refused", async (f) => {
  const refused = await f.admission.prepareGeneration(f.body({ generateAudio: true }), actor);
  expect(refused).toMatchObject({ ok: false, status: 400 });
  expect(JSON.stringify(refused)).toContain(UNAVAILABLE);
  const silent = prepared(await f.admission.prepareGeneration(f.body(), actor));
  /* Approved or not, true or merely truthy: the same refusal, and nothing reserved, kept or dispatched. */
  for (const [value, key] of [[true, "true"], ["yes", "truthy"], [1, "one"]] as const) {
    const reply = await f.post({ ...f.body({ generateAudio: value }), maxCredits: silent.quote.estimatedCredits, quoteFingerprint: silent.quote.fingerprint }, `cinema-sound-refused-${key}`);
    expect(reply.status, key).toBe(400);
    expect(await reply.json(), key).toEqual({ error: UNAVAILABLE });
  }
  expect(await f.rows()).toEqual([]);
  expect(await f.reserved()).toBe(0);
  expect(f.dispatches).toEqual([]);
  /* Off (or said false), the take is the silent one it always was. */
  expect(prepared(await f.admission.prepareGeneration(f.body({ generateAudio: false }), actor)).quote.fingerprint).toBe(silent.quote.fingerprint);
  const accepted = await f.post({ ...f.body(), maxCredits: silent.quote.estimatedCredits, quoteFingerprint: silent.quote.fingerprint }, "cinema-sound-silent");
  expect(accepted.status, await accepted.clone().text()).toBe(202);
  expect(f.dispatches).toHaveLength(1);
}));

test("unset, a workspace that only carries the legacy flag is not the house: sound is refused there, nothing reserved or sent", async () => fixture("cinema_sound_flagged", async (f) => {
  const refused = await f.admission.prepareGeneration(f.body({ generateAudio: true }), actor);
  expect(refused).toMatchObject({ ok: false, status: 400 });
  expect(JSON.stringify(refused)).toContain(UNAVAILABLE);
  const silent = prepared(await f.admission.prepareGeneration(f.body(), actor));
  const reply = await f.post({ ...f.body({ generateAudio: true }), maxCredits: silent.quote.estimatedCredits, quoteFingerprint: silent.quote.fingerprint }, "cinema-sound-flagged");
  expect(reply.status).toBe(400);
  expect(await reply.json()).toEqual({ error: UNAVAILABLE });
  expect(await f.rows()).toEqual([]);
  expect(await f.reserved()).toBe(0);
  expect(f.dispatches).toEqual([]);
}, true));

test("unset, the house workspace (by its id) may still ask for sound, at the figure that is known", async () => fixture(HOUSE_WORKSPACE_ID, async (f) => {
  const silent = prepared(await f.admission.prepareGeneration(f.body(), actor));
  const loud = prepared(await f.admission.prepareGeneration(f.body({ generateAudio: true }), actor));
  expect(params(loud).generateAudio).toBe(true);
  expect(params(loud).higgsfieldVendorCostUsd).toBe(params(silent).higgsfieldVendorCostUsd);
  expect(loud.quote.fingerprint).not.toBe(silent.quote.fingerprint);
  const accepted = await f.post({ ...f.body({ generateAudio: true }), maxCredits: loud.quote.estimatedCredits, quoteFingerprint: loud.quote.fingerprint }, "cinema-sound-house");
  const result = await accepted.json();
  expect(accepted.status, JSON.stringify(result)).toBe(202);
  expect(f.dispatches).toEqual([result.id]);
  expect(JSON.parse(String((await f.rows())[0].params))).toMatchObject({ generateAudio: true });
}, true));

test("set, a take with sound is quoted with what sound adds, its approval is bound to the switch, and a sound reference never turns it on", async () => fixture("cinema_sound_admission", async (f) => {
  process.env[PRICING] = PER_TAKE;
  const silent = prepared(await f.admission.prepareGeneration(f.body(), actor));
  expect(params(silent).generateAudio).toBe(false);
  expect(prepared(await f.admission.prepareGeneration(f.body({ generateAudio: false }), actor)).quote.fingerprint).toBe(silent.quote.fingerprint);
  const loud = prepared(await f.admission.prepareGeneration(f.body({ generateAudio: true }), actor));
  expect(params(loud).generateAudio).toBe(true);
  /* The sound's measured charge is in the provider figure, and so in the credits approved: another, higher approval. */
  expect(params(loud).higgsfieldVendorCostUsd!).toBeCloseTo(params(silent).higgsfieldVendorCostUsd! + 0.5, 10);
  expect(loud.quote).toMatchObject({ approximate: true });
  expect(loud.quote.estimatedCredits).toBeGreaterThan(silent.quote.estimatedCredits);
  expect(loud.quote.fingerprint).not.toBe(silent.quote.fingerprint);
  /* A WAV reference with the switch off: cited, sent, and still silent, at the silent price. */
  const room = await f.upload("room", 6);
  const referenced = prepared(await f.admission.prepareGeneration(f.body({ prompt: "A keeper hums to @Audio1", references: [room] }), actor));
  expect(params(referenced).generateAudio).toBe(false);
  expect((referenced.compiled.references as Reference[]).map((r) => [r.id, r.role])).toEqual([["room", "reference_audio"]]);
  expect(referenced.quote.estimatedCredits).toBe(silent.quote.estimatedCredits);

  /* An approval given with the switch off is not one for sound: refused, nothing kept, nothing dispatched. */
  const swapped = await f.post({ ...f.body({ generateAudio: true }), maxCredits: silent.quote.estimatedCredits, quoteFingerprint: silent.quote.fingerprint }, "cinema-sound-swapped");
  expect(swapped.status, await swapped.text()).toBe(409);
  expect(await f.rows()).toEqual([]);
  /* Approved with sound: accepted once, with the switch on the row and the figure it was approved at. */
  const accepted = await f.post({ ...f.body({ generateAudio: true }), maxCredits: loud.quote.estimatedCredits, quoteFingerprint: loud.quote.fingerprint }, "cinema-sound-once");
  const result = await accepted.json();
  expect(accepted.status, JSON.stringify(result)).toBe(202);
  expect(f.dispatches).toEqual([result.id]);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0].params))).toMatchObject({ generateAudio: true, higgsfieldVendorCostUsd: params(loud).higgsfieldVendorCostUsd });
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
