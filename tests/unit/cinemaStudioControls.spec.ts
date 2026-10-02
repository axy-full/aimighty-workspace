import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
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
import {
  CINEMA_CONTROL_KEYS, CINEMA_STUDIO_CONTROLS, CINEMA_STUDIO_MODEL_ID, cleanCinemaControls, readCinemaControls, type CinemaStudioControls,
} from "../../lib/cinemaStudioTypes";

/**
 * Cinema Studio 4.0's creative controls and sound references: every
 * documented value is accepted and sent as its own parameter, everything else
 * is refused, a control on Auto is left out, and neither the controls nor a
 * sound reference moves the approximate quote or the dispatch re-price. All
 * mocked: injected fetches, ENGINE_MOCK=1, local databases.
 */

const dir = mkdtempSync(path.join(tmpdir(), "particl-cinema-controls-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
const originalFetch = globalThis.fetch;
const requestId = "6d2e5f2b-3c4d-4e6f-9a01-b2c3d4e5f6a7";
const statusUrl = `https://api.higgsfield.ai/requests/${requestId}/status`;
const cancelUrl = `https://api.higgsfield.ai/requests/${requestId}/cancel`;
const actor: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
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

/**
 * The provider's documented input schema for POST /higgsfield/cinema-studio/4.0
 * (its Generate page, read 28 September 2026): the creative controls and their
 * allowed values, and every property the schema has (`additionalProperties: false`).
 */
const DOCUMENTED: Record<string, string[]> = {
  camera_model: ["modern", "35mm-film", "8mm-film", "dv-camcorder"],
  camera_lens: ["clean-sharp", "anamorphic", "vintage-anamorphic", "warm-vintage", "halation-vintage"],
  camera_aperture: ["f14-wide-open", "f4-moderate", "f11-deep-focus"],
  camera_movement: ["snorricam", "robot-arm", "tilt-up", "rack-focus", "tilt-down", "pov", "pan-left", "crane-up", "pan-right", "crane-down",
    "side-tracking", "pedestal-up", "pedestal-down", "handheld", "tracking", "drone-orbit", "dolly-zoom", "aerial-pullback", "static-shot",
    "bullet-time", "whip-pan", "slow-zoom-in", "arc-left", "slow-zoom-out", "arc-right", "truck-right", "dolly-in", "truck-left", "dolly-out",
    "slider-right", "crush-zoom", "slider-left", "helicopter-shot"],
  era: ["1960s", "1980s", "1990s", "2000s", "2020s"],
  genre: ["epic", "drama", "noir", "comedy", "horror", "action"],
  light: ["silhouette", "practicals", "window", "overhead-fall", "contre-jour", "soft-cross"],
  pacing: ["chaotic", "dynamic", "calm", "single-shot"],
  color_palette: ["static-noon", "twilight-fable", "back-row-kissing-seats", "on-the-other-side-of-the-porthole", "the-emerald-ambush",
    "highway-standoff", "the-faded-fresco", "oil-ochre", "the-mountain-convent", "ghost-in-the-code", "pink-velvet", "two-days-to-the-horizon",
    "industrial-fog", "stairs-go-up", "field-post", "home-is-the-next-gas-station", "glossy-flesh", "the-crimson-ballet", "neon-rain-at-midnight",
    "the-morning-after-rain", "the-iron-borough", "the-ground", "the-investigation", "turquoise-mirage", "a-dream-in-color",
    "breakfast-on-schedule", "favela-gold", "a-hotel-for-one", "after-dark", "crimson-vigi", "the-neighbors-saw-everything", "the-grey-channel",
    "mirage-at-noon", "bubblegum-boulevard", "yellow-room", "the-earth-keeps-things-reluctantly", "tropic-fever-dream", "bioluminescent-night",
    "dont-turn-it-off-im-watching", "the-silk-curtain-falls", "the-butterfly", "playtime", "wallpaper-romance", "overtime",
    "the-way-home-is-longer", "everyone-speaks-in-whispers", "runaway-summer", "amber-wasteland", "the-circus", "gasoline-sunset"],
};
const SCHEMA_PROPERTIES = ["era", "genre", "light", "pacing", "prompt", "duration", "audio_urls", "image_urls", "resolution", "video_urls",
  "camera_lens", "aspect_ratio", "camera_model", "color_palette", "generate_audio", "camera_aperture", "camera_movement"];
/** One pick for every control. */
const ALL: CinemaStudioControls = {
  camera_model: "35mm-film", camera_lens: "anamorphic", camera_aperture: "f14-wide-open", camera_movement: "dolly-in",
  era: "1980s", genre: "noir", light: "contre-jour", pacing: "calm", color_palette: "neon-rain-at-midnight",
};

const settings = (patch: Partial<VideoParams> = {}): VideoParams =>
  ({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, generateAudio: true, hasVideoInput: false, ...patch });
const wav = (id: string, patch: Partial<Reference> = {}): Reference =>
  ({ id, kind: "audio", mime: "audio/wav", ext: "wav", storedUrl: `/api/uploads/${id}`, role: "reference_audio", ...patch });
const still = (id: string): Reference => ({ id, kind: "image", mime: "image/png", ext: "png", storedUrl: `/api/uploads/${id}`, role: "reference_image" });
const clip = (id: string): Reference => ({ id, kind: "video", mime: "video/mp4", ext: "mp4", storedUrl: `/api/uploads/${id}`, role: "reference_video" });

/* ── The documented controls ────────────────────────────────────────── */

test("the controls are exactly the provider's documented ones: every control, every value, in its own form's order", () => {
  expect(CINEMA_STUDIO_CONTROLS.map((c) => c.key)).toEqual([...CINEMA_CONTROL_KEYS]);
  expect(CINEMA_STUDIO_CONTROLS.map((c) => c.key)).toEqual(["camera_model", "camera_lens", "camera_aperture", "camera_movement", "era", "genre", "light", "pacing", "color_palette"]);
  for (const control of CINEMA_STUDIO_CONTROLS) {
    expect(control.options.map((o) => o.value), control.key).toEqual(DOCUMENTED[control.key]);
    /* Every value has a name a person reads, and no two share one. */
    expect(control.options.every((o) => o.label.trim().length > 0), control.key).toBe(true);
    expect(new Set(control.options.map((o) => o.label)).size, control.key).toBe(control.options.length);
    expect(control.label.length).toBeGreaterThan(0);
  }
  expect(Object.keys(DOCUMENTED).sort()).toEqual([...CINEMA_CONTROL_KEYS].sort());
  expect(DOCUMENTED.color_palette).toHaveLength(50);
  expect(DOCUMENTED.camera_movement).toHaveLength(33);
  /* Every control is a property of the schema; none of them is "auto" (the schema has no such value). */
  for (const key of CINEMA_CONTROL_KEYS) expect(SCHEMA_PROPERTIES).toContain(key);
  expect(CINEMA_STUDIO_CONTROLS.flatMap((c) => c.options.map((o) => o.value))).not.toContain("auto");
});

test("every documented value of every control is accepted, and sent as that parameter only when picked", async () => {
  const { cinemaStudioInput } = await import("../../lib/cinemaStudio");
  let checked = 0;
  for (const control of CINEMA_STUDIO_CONTROLS) {
    for (const option of control.options) {
      const picked = { [control.key]: option.value };
      expect(readCinemaControls(picked), `${control.key}=${option.value}`).toEqual({ ok: true, controls: picked });
      const body = await cinemaStudioInput("A harbour at dawn", settings({ cinema: picked }), []) as Record<string, unknown>;
      expect(body[control.key], `${control.key}=${option.value}`).toBe(option.value);
      /* Only that control goes: the others stay out, so the model chooses them. */
      for (const other of CINEMA_CONTROL_KEYS) if (other !== control.key) expect(body).not.toHaveProperty(other);
      expect(Object.keys(body).every((key) => SCHEMA_PROPERTIES.includes(key)), JSON.stringify(Object.keys(body))).toBe(true);
      checked++;
    }
  }
  expect(checked).toBe(Object.values(DOCUMENTED).reduce((sum, values) => sum + values.length, 0));
  /* Nothing picked: no control at all, exactly the body a take had before the controls existed. */
  expect(await cinemaStudioInput("A harbour at dawn", settings(), [])).toEqual({ prompt: "A harbour at dawn", duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true });
  expect(await cinemaStudioInput("A harbour at dawn", settings({ cinema: {} }), [])).toEqual({ prompt: "A harbour at dawn", duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true });
  /* All nine at once. */
  const all = await cinemaStudioInput("A harbour at dawn", settings({ cinema: ALL }), []);
  expect(all).toEqual({ prompt: "A harbour at dawn", duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true, ...ALL });
  expect(Object.keys(all).every((key) => SCHEMA_PROPERTIES.includes(key))).toBe(true);
});

test("every invalid value is refused whole: nothing is trimmed, guessed or sent", async () => {
  const { cinemaStudioInput } = await import("../../lib/cinemaStudio");
  const invalid: unknown[] = [];
  CINEMA_STUDIO_CONTROLS.forEach((control, i) => {
    const first = control.options[0].value;
    const other = CINEMA_STUDIO_CONTROLS[(i + 1) % CINEMA_STUDIO_CONTROLS.length].options[0].value;
    const documented = new Set(control.options.map((o) => o.value));
    for (const value of ["auto", "Auto", "AUTO", "", " ", ` ${first}`, `${first} `, `${first}x`, first.toUpperCase(), first.replace(/-/g, "_"), `${first}-`,
      other, 1, 0, true, false, null, [], [first], {}, { value: first }]) {
      /* Only what really is not a documented value of this control (an underscore spelling of a word with no hyphen is the word itself). */
      if (typeof value === "string" && documented.has(value)) continue;
      invalid.push({ [control.key]: value });
    }
  });
  /* Controls that do not exist, and schema properties that are not creative controls. */
  for (const key of ["camera", "focal_length", "palette", "colour_palette", "movement", "seed", "generate_audio", "prompt", "duration", "image_urls", "Camera_Model", "__proto__"])
    invalid.push(JSON.parse(`{${JSON.stringify(key)}:"modern"}`));
  /* Not a set of named controls at all. */
  invalid.push("noir", 7, true, ["genre", "noir"], [{ genre: "noir" }]);
  for (const value of invalid) {
    const read = readCinemaControls(value);
    expect(read.ok, JSON.stringify(value)).toBe(false);
    await expect(cinemaStudioInput("A harbour at dawn", settings({ cinema: value as CinemaStudioControls }), []), JSON.stringify(value)).rejects.toMatchObject({ status: 422 });
  }
  /* A valid pick beside an invalid one is still refused. */
  expect(readCinemaControls({ genre: "noir", era: "1970s" }).ok).toBe(false);
  /* Absent is every control on Auto. */
  expect(readCinemaControls(undefined)).toEqual({ ok: true, controls: {} });
  expect(readCinemaControls(null)).toEqual({ ok: true, controls: {} });
  expect(invalid.length).toBeGreaterThan(9 * 18);
});

test("a stored or held set of picks keeps only documented pairs, in the documented order", () => {
  expect(cleanCinemaControls({ pacing: "calm", genre: "noir", era: "1970s", bogus: "x", camera_model: 3, light: "auto" })).toEqual({ genre: "noir", pacing: "calm" });
  expect(Object.keys(cleanCinemaControls({ color_palette: "after-dark", camera_model: "modern", era: "2020s" }))).toEqual(["camera_model", "era", "color_palette"]);
  expect(readCinemaControls({ color_palette: "after-dark", camera_model: "modern" })).toEqual({ ok: true, controls: { camera_model: "modern", color_palette: "after-dark" } });
  for (const junk of [null, undefined, "noir", 1, [], [["genre", "noir"]]]) expect(cleanCinemaControls(junk)).toEqual({});
});

/* ── Sound references ───────────────────────────────────────────────── */

test("sound references go as audio_urls, cited as <<<audio_N>>>, and only as WAV uploads within the documented limits", async () => {
  const { cinemaStudioInput, cinemaStudioPrompt } = await import("../../lib/cinemaStudio");
  const body = await cinemaStudioInput("@Image1 dances to @Audio1 while @Video1 plays; @Audio2 is not attached", settings({ cinema: { pacing: "dynamic" } }),
    [still("frame"), wav("score"), clip("dance")]);
  expect(body).toEqual({
    prompt: "<<<image_1>>> dances to <<<audio_1>>> while <<<video_1>>> plays; @Audio2 is not attached",
    duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true,
    image_urls: [expect.stringMatching(/uploads\/frame\.png$/)],
    video_urls: [expect.stringMatching(/uploads\/dance\.mp4$/)],
    audio_urls: [expect.stringMatching(/uploads\/score\.wav$/)],
    pacing: "dynamic",
  });
  expect(cinemaStudioPrompt("@audio1 and @AUDIO2 and @Audio10", 0, 0, 2)).toBe("<<<audio_1>>> and <<<audio_2>>> and @Audio10");
  /* Ten sounds, the provider's ceiling, and fifty references in all, go. */
  const full = await cinemaStudioInput("x", settings(), [
    ...Array.from({ length: 30 }, (_, i) => still(`s${i}`)), ...Array.from({ length: 10 }, (_, i) => clip(`c${i}`)), ...Array.from({ length: 10 }, (_, i) => wav(`a${i}`)),
  ]) as { audio_urls: string[] };
  expect(full.audio_urls).toHaveLength(10);
  expect(await cinemaStudioInput("x", settings(), [wav("mixed", { mime: "audio/x-wav" })])).toHaveProperty("audio_urls");
  for (const references of [
    Array.from({ length: 11 }, (_, i) => wav(`a${i}`)),
    [wav("mp3", { mime: "audio/mpeg", ext: "mp3" })],
    [wav("m4a", { mime: "audio/mp4", ext: "m4a" })],
    [wav("made", { fromGeneration: true })],
    [wav("wrongrole", { role: "reference_image" })],
    [{ ...still("wrongkind"), role: "reference_audio" }],
    [wav("../escape")],
  ] as Reference[][])
    await expect(cinemaStudioInput("x", settings(), references), JSON.stringify(references.slice(0, 1))).rejects.toMatchObject({ status: 422 });
});

/* ── The price: controls and sounds are not in the published formula ── */

test("the approximate quote and the workbench price are the same with every control and sound reference set", async () => {
  const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
  const { quoteWorkbenchMedia } = await import("../../lib/workbench/media-quote");
  const { getModel } = await import("../../lib/models");
  const plain = cinemaStudioQuoteUsd(settings())!;
  expect(plain).toBeGreaterThan(0);
  expect(cinemaStudioQuoteUsd(settings({ cinema: ALL }))).toBe(plain);
  for (const control of CINEMA_STUDIO_CONTROLS)
    for (const option of control.options)
      expect(cinemaStudioQuoteUsd(settings({ cinema: { [control.key]: option.value } })), `${control.key}=${option.value}`).toBe(plain);
  /* A clip still moves it (the published formula's video input); the controls still do not. */
  const withClip = cinemaStudioQuoteUsd(settings({ hasVideoInput: true, inputSeconds: 4 }))!;
  expect(withClip).not.toBe(plain);
  expect(cinemaStudioQuoteUsd(settings({ hasVideoInput: true, inputSeconds: 4, cinema: ALL }))).toBe(withClip);
  /* The composer's price read: sound references are counted, never priced, and never count as video input. */
  const cinema = getModel(CINEMA_STUDIO_MODEL_ID);
  const at = { resolution: "720p", ratio: "16:9", duration: 5 };
  const none = { images: 1, videos: 0, inputSeconds: 0, hasVideoInput: false };
  const base = quoteWorkbenchMedia(cinema, at, none);
  expect(base).toMatchObject({ approximate: true, hasVideoInput: false });
  expect(quoteWorkbenchMedia(cinema, at, { ...none, audios: 10, audioSeconds: 30 })).toEqual(base);
});

test("the composer's price read counts WAV sounds for Cinema Studio, says why others cannot go, and refuses sound on every other engine", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { referencePrices, quoteWorkbenchMedia } = await import("../../lib/workbench/media-quote");
  const { getModel } = await import("../../lib/models");
  await runInTenant(workspace("cinema_quote_refs"), async () => {
    await ready();
    const insert = (id: string, mime: string, kind: string, seconds: number | null) => db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,64,'s',?,?,?,0)",
      args: [id, id, mime, mime.split("/")[1], `/api/uploads/${id}`, kind, seconds],
    });
    await insert("room", "audio/wav", "audio", 12);
    await insert("song", "audio/wav", "audio", 20);
    await insert("voice", "audio/mpeg", "audio", 5);
    await insert("hum", "audio/wav", "audio", null);
    await insert("look", "image/png", "image", null);
    await db().execute("INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at) VALUES('made_sound','audio','eleven_sfx','rain','{}','succeeded','/api/media/made_sound',0,0)");
    const at = { resolution: "720p", ratio: "16:9", duration: 5 };
    const cinema = getModel(CINEMA_STUDIO_MODEL_ID), seedance = getModel("dreamina-seedance-2-5-260628");
    /* No sound: the shape every other engine already read. */
    expect(await referencePrices([{ uploadId: "look" }])).toEqual({ images: 1, videos: 0, inputSeconds: 0, hasVideoInput: false });
    const one = await referencePrices([{ uploadId: "look" }, { uploadId: "room" }]);
    expect(one).toEqual({ images: 1, videos: 0, inputSeconds: 0, hasVideoInput: false, audios: 1, audioSeconds: 12 });
    expect(quoteWorkbenchMedia(cinema, at, one).credits).toBe(quoteWorkbenchMedia(cinema, at, await referencePrices([{ uploadId: "look" }])).credits);
    expect(() => quoteWorkbenchMedia(seedance, at, one)).toThrow("takes pictures and video as references, not sound");
    /* Past the 30 s sound budget, an MP3, an unmeasured length, a generated sound: each says why. */
    expect(() => quoteWorkbenchMedia(cinema, at, { ...one, audios: 2, audioSeconds: 32 })).toThrow("32.0 s");
    expect(() => quoteWorkbenchMedia(cinema, at, { ...one, audios: 11, audioSeconds: 11 })).toThrow("up to 10 sound references");
    const long = await referencePrices([{ uploadId: "room" }, { uploadId: "song" }]);
    const mp3 = await referencePrices([{ uploadId: "voice" }]);
    const unmeasured = await referencePrices([{ uploadId: "hum" }]);
    const generated = await referencePrices([{ genId: "made_sound" }]);
    expect(() => quoteWorkbenchMedia(cinema, at, long)).toThrow("32.0 s");
    expect(() => quoteWorkbenchMedia(cinema, at, mp3)).toThrow("WAV");
    expect(() => quoteWorkbenchMedia(cinema, at, unmeasured)).toThrow("length is unavailable");
    expect(() => quoteWorkbenchMedia(cinema, at, generated)).toThrow("Generated sounds are MP3");
  }, actor);
});

/* ── Dispatch: re-priced with the controls set, and checked again ────── */

function workspace(name: string): TenantWorkspace {
  return { id: name, slug: name, name, legacy: true, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 20, rendersPerHour: 200, storageQuotaBytes: null, deletedAt: null };
}

test("dispatch re-prices to the same figure with the controls set, sends them once, and sends nothing when they no longer check", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("cinema_controls_dispatch"), async () => {
    const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio");
    const { getModel } = await import("../../lib/models"), { getTask } = await import("../../lib/tasks");
    const { higgsfield } = await import("../../lib/engines/higgsfield"), { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
    const params: VideoParams = { ...settings({ cinema: ALL }), higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: cinemaStudioQuoteUsd(settings())! };
    const req: VideoRenderRequest = { kind: "video", genId: "gen_cinema_controls", model: getModel(CINEMA_STUDIO_MODEL_ID), task: getTask("generate"), prompt: "A harbour at dawn", params, references: [], source: null };
    /* The kept quote was made without the controls; with them the re-price is the same figure, so the take goes. */
    expect(cinemaStudioQuoteUsd(params)).toBe(params.higgsfieldVendorCostUsd);
    expect(higgsfield.estimate(req)).toBe(params.higgsfieldVendorCostUsd);
    process.env.ENGINE_MOCK = "0";
    /* Admitted on the live connection this dispatch will use. */
    params.higgsfieldCredentialFingerprint = higgsfieldCredentialFingerprint();
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ request_id: requestId, status: "queued", status_url: statusUrl, cancel_url: cancelUrl });
    };
    const out = await higgsfield.render(req);
    expect(calls).toEqual([{ url: "https://api.higgsfield.ai/higgsfield/cinema-studio/4.0",
      body: { prompt: "A harbour at dawn", duration: 5, resolution: "720p", aspect_ratio: "16:9", generate_audio: true, ...ALL } }]);
    expect(out).toMatchObject({ handle: { provider: "higgsfield", model: CINEMA_STUDIO_MODEL_ID, ref: requestId } });
    calls.length = 0;
    /* A control that no longer checks (a row edited since, a value the provider dropped): nothing is sent. */
    for (const cinema of [{ ...ALL, genre: "western" }, { ...ALL, era: "auto" }, { bogus: "x" }] as CinemaStudioControls[])
      await expect(higgsfield.render({ ...req, params: { ...params, cinema } }), JSON.stringify(cinema)).rejects.toThrow(/Nothing was submitted/);
    /* A sound that is not a WAV upload is not sent either (checked in mock storage, before any request). */
    process.env.ENGINE_MOCK = "1";
    params.higgsfieldCredentialFingerprint = higgsfieldCredentialFingerprint();
    await expect(higgsfield.render({ ...req, references: [wav("voice", { mime: "audio/mpeg", ext: "mp3" })] })).rejects.toThrow(/Nothing was submitted/);
    await expect(higgsfield.render({ ...req, references: [wav("room")] })).resolves.toHaveProperty("handle");
    expect(calls).toEqual([]);
  }, actor);
});

test("a held or queued take rebuilds its sound reference from its row, as the sound it was quoted as", async () => {
  const { runInTenant } = await import("../../lib/tenant"), { engineFor } = await import("../../lib/engines"), { submitVideoRow } = await import("../../lib/submitVideo");
  const { db, ready, now } = await import("../../lib/db"), { meter } = await import("../../lib/meter");
  const { cinemaStudioQuoteUsd } = await import("../../lib/cinemaStudio"), { higgsfieldCredentialFingerprint } = await import("../../lib/higgsfield");
  const engine = engineFor("higgsfield"), render = engine.render;
  const seen: Reference[][] = [], sent: unknown[] = [];
  engine.render = async (req) => {
    if (req.kind !== "video") throw new Error("video only");
    seen.push(req.references);
    sent.push(req.params.cinema);
    return { handle: { provider: "higgsfield", model: req.model.id, ref: requestId, endpoint: statusUrl, credentialFingerprint: req.params.higgsfieldCredentialFingerprint } };
  };
  try {
    await runInTenant(workspace("cinema_controls_rows"), async () => {
      /* Every workspace pays in credits: these takes are reserved from this fixture's own funds. */
      await ready(); await fundFixtureWorkspace();
      await db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES('room','room.wav','audio/wav','wav',64,'s','/api/uploads/room','audio',6,0)");
      await db().execute("INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES('look','look.png','image/png','png',64,'s','/api/uploads/look','image',NULL,0)");
      const usd = cinemaStudioQuoteUsd(settings())!;
      const row = async (id: string, references: unknown[]) => {
        const params = { ...settings({ cinema: { genre: "noir" } }), higgsfieldCredentialFingerprint: higgsfieldCredentialFingerprint(), higgsfieldVendorCostUsd: usd, references };
        await db().execute({ sql: "INSERT INTO generations(id,kind,model,prompt,params,status,provider,task,created_by,created_at,updated_at) VALUES(?,'video',?,'@Image1 hums @Audio1',?,'queued','higgsfield','generate','owner',?,?)", args: [id, CINEMA_STUDIO_MODEL_ID, JSON.stringify(params), now(), now()] });
        await meter({ id, kind: "video", engine: "higgsfield", model: CINEMA_STUDIO_MODEL_ID, status: "running", engineCostUsd: usd });
      };
      await row("gen_rows_ok", [{ uploadId: "look", role: "reference_image", kind: "image" }, { uploadId: "room", role: "reference_audio", kind: "audio" }]);
      expect((await submitVideoRow("gen_rows_ok")).ok).toBe(true);
      expect(seen[0].map((r) => [r.id, r.kind, r.role, r.mime])).toEqual([["look", "image", "reference_image", "image/png"], ["room", "audio", "reference_audio", "audio/wav"]]);
      expect(sent[0]).toEqual({ genre: "noir" });
      /* A row that calls a picture a sound (or the other way round) is never sent. */
      await row("gen_rows_mismatch", [{ uploadId: "look", role: "reference_audio", kind: "audio" }]);
      expect((await submitVideoRow("gen_rows_mismatch")).ok).toBe(false);
      await row("gen_rows_mismatch2", [{ uploadId: "room", role: "reference_image", kind: "image" }]);
      expect((await submitVideoRow("gen_rows_mismatch2")).ok).toBe(false);
      expect(seen).toHaveLength(1);
    }, actor);
  } finally { engine.render = render; }
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
  await grantCredits(name, 100000, "Cinema Studio controls test", actor.user.id, "manual");
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
  async function upload(id: string, kind: "image" | "video" | "audio", seconds: number | null = null, mime?: string) {
    const type = mime ?? (kind === "image" ? "image/png" : kind === "video" ? "video/mp4" : "audio/wav");
    await database.db().execute({
      sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,128,'fixture-sha',?,?,?,0)",
      args: [id, id, type, type.split("/")[1].replace("x-", "").replace("mpeg", "mp3"), `/api/uploads/${id}`, kind, seconds],
    });
    return { uploadId: id, role: kind === "image" ? "reference_image" : kind === "video" ? "reference_video" : "reference_audio" };
  }
  const body = (patch: Record<string, unknown> = {}) => ({ model: CINEMA_STUDIO_MODEL_ID, prompt: "A lighthouse keeper waits on the pier", ratio: "16:9", resolution: "720p", duration: 5, projectId: "project", refine: false, ...patch });
  const post = (value: Record<string, unknown>, key: string) => handler.POST(new Request("http://localhost/api/generate", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(value) }));
  const rows = async () => (await database.db().execute({ sql: "SELECT * FROM generations WHERE model=?", args: [CINEMA_STUDIO_MODEL_ID] })).rows;
  return { admission, upload, body, post, rows, dispatches, db: database.db };
}
function prepared(result: PrepareAdmissionResult): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
function refused(result: PrepareAdmissionResult, message: RegExp | string) {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: false, status: 400 });
  if (result.ok) return;
  expect(JSON.stringify(result)).toMatch(message);
}

test("admission keeps the checked controls on the take, prices it exactly as without them, and binds the approval to them", async () => fixture("cinema_controls_admission", async (f) => {
  const plain = prepared(await f.admission.prepareGeneration(f.body(), actor));
  const directed = prepared(await f.admission.prepareGeneration(f.body({ cinema: { color_palette: "after-dark", genre: "noir", camera_movement: "crane-up" } }), actor));
  /* Stored in the documented order, whatever order they came in. */
  expect(directed.compiled.params).toMatchObject({ cinema: { camera_movement: "crane-up", genre: "noir", color_palette: "after-dark" } });
  expect(Object.keys((directed.compiled.params as VideoParams).cinema!)).toEqual(["camera_movement", "genre", "color_palette"]);
  expect(plain.compiled.params).not.toHaveProperty("cinema");
  expect(prepared(await f.admission.prepareGeneration(f.body({ cinema: {} }), actor)).compiled.params).not.toHaveProperty("cinema");
  /* The same approximate figure; a different approval (the fingerprint covers what is sent). */
  expect(directed.quote).toMatchObject({ approximate: true, estimatedCredits: plain.quote.estimatedCredits });
  expect((directed.compiled.params as VideoParams).higgsfieldVendorCostUsd).toBe((plain.compiled.params as VideoParams).higgsfieldVendorCostUsd);
  expect(directed.quote.fingerprint).not.toBe(plain.quote.fingerprint);
  const all = prepared(await f.admission.prepareGeneration(f.body({ cinema: ALL }), actor));
  expect(all.quote.estimatedCredits).toBe(plain.quote.estimatedCredits);

  /* Accepted once, at that price, with the controls on the row. */
  const approved = { ...f.body({ cinema: ALL }), maxCredits: all.quote.estimatedCredits, quoteFingerprint: all.quote.fingerprint };
  const accepted = await f.post(approved, "cinema-controls-once");
  const result = await accepted.json();
  expect(accepted.status, JSON.stringify(result)).toBe(202);
  expect(f.dispatches).toEqual([result.id]);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(String(rows[0].params))).toMatchObject({ cinema: ALL, higgsfieldVendorCostUsd: (plain.compiled.params as VideoParams).higgsfieldVendorCostUsd });
  /* An approval given for other controls is not this request's. */
  const swapped = await f.post({ ...f.body({ cinema: { ...ALL, genre: "comedy" } }), maxCredits: all.quote.estimatedCredits, quoteFingerprint: all.quote.fingerprint }, "cinema-controls-swapped");
  expect(swapped.status, await swapped.text()).toBe(409);
  expect(f.dispatches).toHaveLength(1);
}));

test("admission refuses an invalid control, controls on any other engine, and never stores what it refused", async () => fixture("cinema_controls_refusals", async (f) => {
  for (const cinema of [{ genre: "auto" }, { genre: "Noir" }, { genre: "1980s" }, { era: 1980 }, { focal_length: "35mm" }, { generate_audio: false }, "noir", ["noir"], { light: null }])
    refused(await f.admission.prepareGeneration(f.body({ cinema }), actor), /Cinema Studio/);
  for (const model of ["dreamina-seedance-2-5-260628", "gemini-3.1-flash-image"]) {
    refused(await f.admission.prepareGeneration(f.body({ model, cinema: { genre: "noir" } }), actor), "need the Cinema Studio 4.0 engine");
    refused(await f.admission.prepareGeneration(f.body({ model, cinema: {} }), actor), "need the Cinema Studio 4.0 engine");
  }
  const rejected = await f.post({ ...f.body({ cinema: { genre: "western" } }), maxCredits: 100000 }, "cinema-controls-invalid");
  expect(rejected.status, await rejected.text()).toBe(400);
  expect(await f.rows()).toEqual([]);
  expect(f.dispatches).toEqual([]);
}));

test("admission takes WAV sound references for Cinema Studio only, within the documented limits, and they never move the price", async () => fixture("cinema_controls_sounds", async (f) => {
  const look = await f.upload("look", "image"), room = await f.upload("room", "audio", 12), song = await f.upload("song", "audio", 20);
  const voice = await f.upload("voice", "audio", 4, "audio/mpeg"), hum = await f.upload("hum", "audio", null);
  const plain = prepared(await f.admission.prepareGeneration(f.body({ prompt: "@Image1 hums along to @Audio1", references: [look] }), actor));
  const sounded = prepared(await f.admission.prepareGeneration(f.body({ prompt: "@Image1 hums along to @Audio1", references: [look, room] }), actor));
  expect((sounded.compiled.references as Reference[]).map((r) => [r.id, r.kind, r.role])).toEqual([["look", "image", "reference_image"], ["room", "audio", "reference_audio"]]);
  expect(sounded.quote.estimatedCredits).toBe(plain.quote.estimatedCredits);
  /* A sound is not video input: the rate and the seconds billed are the same as without it. */
  expect(sounded.compiled.params).toMatchObject({ hasVideoInput: false });
  expect((sounded.compiled.params as VideoParams).inputSeconds).toBeUndefined();
  expect((sounded.compiled.params as VideoParams).higgsfieldVendorCostUsd).toBe((plain.compiled.params as VideoParams).higgsfieldVendorCostUsd);
  /* A client's claimed role cannot make a sound a picture: the row says what it is. */
  const claimed = prepared(await f.admission.prepareGeneration(f.body({ references: [{ uploadId: "room", role: "reference_image" }] }), actor));
  expect((claimed.compiled.references as Reference[]).map((r) => [r.kind, r.role])).toEqual([["audio", "reference_audio"]]);
  const accepted = await f.post({ ...f.body({ prompt: "@Image1 hums along to @Audio1", references: [look, room] }), maxCredits: sounded.quote.estimatedCredits, quoteFingerprint: sounded.quote.fingerprint }, "cinema-sound-once");
  expect(accepted.status, await accepted.text()).toBe(202);
  expect(JSON.parse(String((await f.rows())[0].params)).references).toEqual([
    { uploadId: "look", role: "reference_image", kind: "image" }, { uploadId: "room", role: "reference_audio", kind: "audio" }]);

  refused(await f.admission.prepareGeneration(f.body({ references: [room, song] }), actor), /32\.0 s/);
  refused(await f.admission.prepareGeneration(f.body({ references: [voice] }), actor), /WAV/);
  refused(await f.admission.prepareGeneration(f.body({ references: [hum] }), actor), /length is unavailable/);
  const many = await Promise.all(Array.from({ length: 11 }, (_, i) => f.upload(`beat${i}`, "audio", 1)));
  refused(await f.admission.prepareGeneration(f.body({ references: many }), actor), /up to 10 sound references/);
  await f.db().execute("INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at) VALUES('made_sound','audio','eleven_sfx','rain','{}','succeeded','/api/media/made_sound',0,0)");
  refused(await f.admission.prepareGeneration(f.body({ references: [{ genId: "made_sound", role: "reference_image" }] }), actor), /Generated sounds are MP3/);
  /* Every other engine refuses a sound outright (it used to be read as a picture). */
  refused(await f.admission.prepareGeneration(f.body({ model: "dreamina-seedance-2-5-260628", references: [room] }), actor), "A sound can't be a visual reference");
  refused(await f.admission.prepareGeneration(f.body({ model: "dreamina-seedance-2-5-260628", references: [{ genId: "made_sound", role: "reference_image" }] }), actor), "A sound can't be a visual reference");
}));

test("the prompt compiler writes no camera, light or look module where Cinema Studio's own control directs it", async () => fixture("cinema_controls_compiler", async (f) => {
  const { CATEGORIES, hasCameraModule } = await import("../../lib/studio");
  const bankModule = (row: string, value: string) => CATEGORIES.find((c) => c.key === row)!.options.find((o) => o.value === value)!.module!;
  const words = "A lighthouse keeper waits under neon on a desaturated pier";
  const neon = bankModule("light", "neon"), muted = bankModule("look", "muted");
  /* Auto everywhere: the light and look the words name expand as on every engine; the camera is the model's to
     choose, so no camera sentence is written (tests/unit/cinemaSound.spec.ts). */
  const auto = String(prepared(await f.admission.prepareGeneration(f.body({ prompt: words }), actor)).compiled.prompt);
  expect(hasCameraModule(auto)).toBe(false);
  expect(auto).toContain(neon);
  expect(auto).toContain(muted);
  /* A picked movement: no camera sentence (the parameter moves the camera); light and look still expand. */
  const moved = String(prepared(await f.admission.prepareGeneration(f.body({ prompt: words, cinema: { camera_movement: "crane-up" } }), actor)).compiled.prompt);
  expect(hasCameraModule(moved)).toBe(false);
  expect(moved).toContain(neon);
  expect(moved).toContain(muted);
  /* A picked light, camera body or palette: that module goes too. */
  const lit = String(prepared(await f.admission.prepareGeneration(f.body({ prompt: words, cinema: { light: "silhouette" } }), actor)).compiled.prompt);
  expect(lit).not.toContain(neon);
  expect(lit).toContain(muted);
  for (const cinema of [{ color_palette: "after-dark" }, { camera_model: "8mm-film" }]) {
    const graded = String(prepared(await f.admission.prepareGeneration(f.body({ prompt: words, cinema }), actor)).compiled.prompt);
    expect(graded, JSON.stringify(cinema)).not.toContain(muted);
    expect(graded).toContain(neon);
  }
  /* Everything directed: the words are the person's own. */
  const all = prepared(await f.admission.prepareGeneration(f.body({ prompt: words, cinema: ALL }), actor)).compiled.prompt;
  expect(all).toBe(words);
  /* Controls that direct nothing the server writes (genre, era, pacing…) leave the compiler as it was. */
  expect(prepared(await f.admission.prepareGeneration(f.body({ prompt: words, cinema: { genre: "noir", era: "1960s", pacing: "calm" } }), actor)).compiled.prompt).toBe(auto);
}));

/* ── Gen: the chip bank, the composer, Recreate and the saved node ───── */

test("Gen's Cinema chips: nine documented controls, each Auto until picked, a grid per control and # over their names", async () => {
  const { CINEMA_BANK, CINEMA_CHIPS, cinemaForSend, cinemaLabels, recipeCinema } = await import("../../lib/workspace/cinema-vocabulary");
  const { hashDefault } = await import("../../lib/workspace/film-vocabulary");
  expect(CINEMA_CHIPS.map((c) => c.label)).toEqual(["Camera", "Lens", "Aperture", "Movement", "Era", "Genre", "Light", "Pacing", "Palette"]);
  for (const chip of CINEMA_BANK.chips) {
    const options = CINEMA_BANK.options(chip);
    expect(options.map((o) => o.value), chip.key).toEqual(DOCUMENTED[chip.key]);
    /* Movement is drawn; a genre, an era or a palette is a name alone. */
    expect(options.every((o) => (chip.key === "camera_movement" ? !o.plain : o.plain === true)), chip.key).toBe(true);
    expect(options.every((o) => o.previewKey === null)).toBe(true);
    expect(CINEMA_BANK.value(chip, {})).toEqual({ text: "Auto", set: false });
  }
  const movement = CINEMA_BANK.chips.find((c) => c.key === "camera_movement")!;
  let setup = CINEMA_BANK.pick({}, movement, { row: "camera_movement", value: "dolly-in" });
  expect(setup).toEqual({ camera_movement: "dolly-in" });
  expect(CINEMA_BANK.value(movement, setup)).toEqual({ text: "Dolly in", set: true });
  /* Picking what is held puts it back to Auto; Auto clears it; a junk row never survives a pick. */
  expect(CINEMA_BANK.pick(setup, movement, { row: "camera_movement", value: "dolly-in" })).toEqual({});
  expect(CINEMA_BANK.pick({ ...setup, genre: "noir" }, movement, null)).toEqual({ genre: "noir" });
  expect(CINEMA_BANK.pick({ junk: "x" }, movement, { row: "camera_movement", value: "pov" })).toEqual({ camera_movement: "pov" });
  setup = CINEMA_BANK.pick(setup, CINEMA_BANK.chips.find((c) => c.key === "color_palette")!, { row: "color_palette", value: "crimson-vigi" });
  expect(cinemaLabels(setup)).toEqual(["Dolly in", "Crimson Vigil"]);
  expect(CINEMA_BANK.extras(setup)).toEqual([]);
  /* # over the names: movements first, a name's start before a word's, never a fragment inside a word. */
  expect(CINEMA_BANK.matches("dolly").map((h) => h.label)).toEqual(["Dolly zoom", "Dolly in", "Dolly out"]);
  expect(CINEMA_BANK.matches("noir").map((h) => [h.chipLabel, h.label])).toEqual([["Genre", "Noir"]]);
  expect(CINEMA_BANK.matches("")).toHaveLength(8);
  expect(CINEMA_BANK.matches("").every((h) => h.chip === "camera_movement")).toBe(true);
  expect(CINEMA_BANK.matches("oir")).toEqual([]);
  expect(hashDefault("do", CINEMA_BANK.matches("do"))).toBe(0);
  /* What is sent: documented pairs only. */
  expect(cinemaForSend({ genre: "noir", junk: "x", era: "auto" })).toEqual({ genre: "noir" });
  /* Recreate's card: kept, changed here, or not on Cinema Studio now. */
  expect(recipeCinema({ genre: "noir" }, { genre: "noir" }, true)).toEqual({ labels: ["Noir"], kept: true });
  expect(recipeCinema({ genre: "noir" }, { genre: "drama" }, true)).toEqual({ labels: ["Noir"], kept: false, why: "Changed here" });
  expect(recipeCinema({ genre: "noir" }, { genre: "noir" }, false)).toEqual({ labels: ["Noir"], kept: false, why: "Only Cinema Studio takes these" });
});

test("the composer holds the picks, Recreate brings them back, a request carries them, and sound blocks every engine but Cinema Studio", async () => {
  const { composerReducer, composerBlock, INITIAL_COMPOSER } = await import("../../lib/workspace/composer");
  const { generationRequestBody } = await import("../../lib/workbench/generation-request");
  const { recreatePreset } = await import("../../lib/shell/recipe");
  const picked = composerReducer(INITIAL_COMPOSER, { type: "cinema", value: { genre: "noir" } });
  expect(picked.cinema).toEqual({ genre: "noir" });
  expect(picked.shot).toEqual({});
  expect(composerReducer(picked, { type: "reset" }).cinema).toEqual({});
  const recreated = composerReducer(picked, { type: "recipe", value: { type: "video", billing: "workspace", model: CINEMA_STUDIO_MODEL_ID, picks: {}, cinema: { era: "1960s" } } });
  expect(recreated.cinema).toEqual({ era: "1960s" });
  expect(composerReducer(picked, { type: "recipe", value: { type: "video", billing: "workspace", picks: {} } }).cinema).toEqual({});

  const preset = recreatePreset({ id: "gen_x", kind: "video", model: CINEMA_STUDIO_MODEL_ID, prompt: "p", provider: "higgsfield", task: "generate",
    params: { ratio: "16:9", resolution: "720p", duration: 5, cinema: { genre: "noir", era: "auto", junk: "x" }, references: [{ uploadId: "room", role: "reference_audio", kind: "audio" }] } } as never, { name: "Take" });
  expect(preset.cinema).toEqual({ genre: "noir" });
  expect(preset.references).toEqual([{ origin: "upload", id: "room", role: "reference_audio", kind: "audio" }]);
  expect(recreatePreset({ id: "gen_y", kind: "video", model: "m", prompt: "p", provider: "mock", task: "generate", params: {} } as never, { name: "T" })).not.toHaveProperty("cinema");

  const request = { prompt: "p", kind: "video" as const, model: { id: CINEMA_STUDIO_MODEL_ID }, mapping: { shotId: "s", productionProjectId: "p" }, ratio: "16:9", resolution: "720p", duration: 5, references: [] };
  expect(generationRequestBody({ ...request, cinema: { genre: "noir" } })).toMatchObject({ cinema: { genre: "noir" } });
  for (const cinema of [undefined, null, {}]) expect(generationRequestBody({ ...request, cinema })).not.toHaveProperty("cinema");

  const model = (id: string) => ({ id, label: id === CINEMA_STUDIO_MODEL_ID ? "Cinema Studio 4.0" : "Seedance 2.5", type: "video" as const });
  const input = (id: string, billing: "workspace" | "connected" = "workspace") => ({
    state: { ...INITIAL_COMPOSER, billing, type: "video" as const, prompt: "a wave" }, model: model(id), quote: { key: "k", credits: 5, state: "ready" as const, reason: null }, quoteKey: "k",
    submitting: false, capability: billing === "connected" ? { owner: true, connected: true, suspended: false } : null, catalogue: { loading: false, error: null }, soundReferences: 1,
  });
  expect(composerBlock(input(CINEMA_STUDIO_MODEL_ID))).toBeNull();
  expect(composerBlock(input("dreamina-seedance-2-5-260628"))).toBe("Seedance 2.5 takes pictures and video as references, not sound. Remove the sound, or choose Cinema Studio 4.0.");
  expect(composerBlock(input(CINEMA_STUDIO_MODEL_ID, "connected"))).toMatch(/not sound/);
  expect(composerBlock({ ...input("dreamina-seedance-2-5-260628"), soundReferences: 0 })).toBeNull();
});

test("a saved node keeps its Cinema controls only as documented values", async () => {
  const { moleculrSchema } = await import("../../lib/workbench/studio-schema");
  const { EMPTY_MOLECULR } = await import("../../lib/workbench/moleculr");
  const brief = (cinema: unknown) => ({ ...EMPTY_MOLECULR, variants: [{ id: "v1", nodeId: "n1", hook: "", generation: { modelId: CINEMA_STUDIO_MODEL_ID, cinema } }] });
  expect(moleculrSchema.safeParse(brief(ALL)).success).toBe(true);
  expect(moleculrSchema.safeParse(brief({})).success).toBe(true);
  for (const bad of [{ genre: "auto" }, { genre: "western" }, { focal_length: "35mm" }, { era: 1980 }, "noir"])
    expect(moleculrSchema.safeParse(brief(bad)).success, JSON.stringify(bad)).toBe(false);
});
