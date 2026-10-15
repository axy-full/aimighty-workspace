import { test, expect } from "@playwright/test";
import { VEO_RATES, VeoError, fetchResult, pollVideo, submitVideo, veoBase, veoHostUrl, veoQuoteUsd, veoSettingsError, type VeoRequest } from "../../lib/veo";

/**
 * The Veo 3.1 adapter (lib/veo.ts) alone: no database, no route, no money. Every call is a function this file hands the adapter, or the in-process fixture under
 * ENGINE_MOCK=1; no request leaves this process and no provider is paid. The prices in the quote tests are the table's own (TO CONFIRM, see lib/veo.ts), so these
 * tests prove the arithmetic and the guards, not that the figures are Google's.
 */
const KEY = "unit-test-gemini-key-not-real";
test.beforeEach(() => { process.env.GEMINI_API_KEY = KEY; process.env.ENGINE_MOCK = ""; delete process.env.GEMINI_BASE_URL; });
test.afterEach(() => { delete process.env.GEMINI_API_KEY; delete process.env.GEMINI_BASE_URL; process.env.ENGINE_MOCK = "1"; });

const request = (over: Partial<VeoRequest> = {}): VeoRequest => ({ model: "veo-3.1-generate-preview", prompt: "A paper boat on a puddle.", durationSeconds: 8, resolution: "720p", aspectRatio: "16:9", ...over });
type Seen = { url: string; init: RequestInit };
const answer = (status: number, body: unknown, seen: Seen[] = []): typeof fetch => (async (url: string, init: RequestInit) => { seen.push({ url: String(url), init }); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); }) as never;
const OP = "models/veo-3.1-generate-preview/operations/abc123_DEF-9";

test("the quote is the rate times the seconds, rounded up, for every offered model and size; settings the vendor does not take are refused before any request", () => {
  for (const [model, def] of Object.entries(VEO_RATES.models)) {
    for (const resolution of VEO_RATES.resolutions) {
      for (const durationSeconds of VEO_RATES.durations) {
        expect(veoQuoteUsd({ model: model as never, resolution, durationSeconds }), `${model} ${resolution} ${durationSeconds}`).toBeCloseTo(def.usdPerSecond[resolution] * durationSeconds, 6);
      }
    }
  }
  expect(() => veoQuoteUsd({ model: "veo-9" as never, resolution: "720p", durationSeconds: 8 })).toThrow(VeoError);
  expect(() => veoQuoteUsd({ model: "veo-3.1-generate-preview", resolution: "720p", durationSeconds: 5 })).toThrow(VeoError);
  expect(() => veoQuoteUsd({ model: "veo-3.1-generate-preview", resolution: "4k" as never, durationSeconds: 8 })).toThrow(VeoError);
  expect(veoSettingsError(request())).toBeNull();
  expect(veoSettingsError(request({ durationSeconds: 5 }))).toMatch(/seconds/);
  expect(veoSettingsError(request({ resolution: "1080p", durationSeconds: 6 }))).toBe("1080p clips are 8 seconds.");
  expect(veoSettingsError(request({ aspectRatio: "1:1" as never }))).toMatch(/shape/);
  expect(veoSettingsError({ ...request(), references: [1, 2, 3, 4] })).toMatch(/At most 3/);
  expect(veoSettingsError({ ...request({ durationSeconds: 6 }), references: [1] })).toMatch(/8 seconds/);
  expect(veoSettingsError({ ...request({ aspectRatio: "9:16" }), references: [1] })).toMatch(/16:9/);
});

test("only an https host under googleapis.com is ever called or followed: no http, no other host, no look-alike, no credentials, no port; GEMINI_BASE_URL is held to the same rule", () => {
  expect(veoHostUrl("https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media")?.hostname).toBe("generativelanguage.googleapis.com");
  for (const bad of ["http://generativelanguage.googleapis.com/x", "https://example.com/x", "https://googleapis.com.evil.example/x", "https://evilgoogleapis.com/x", "https://user:pw@generativelanguage.googleapis.com/x", "https://generativelanguage.googleapis.com:8443/x", "file:///etc/passwd", "//generativelanguage.googleapis.com/x", "", 5, null]) expect(veoHostUrl(bad), String(bad)).toBeNull();
  expect(veoBase()).toBe("https://generativelanguage.googleapis.com");
  process.env.GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/";
  expect(veoBase()).toBe("https://generativelanguage.googleapis.com");
  for (const bad of ["https://example.com", "http://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta", "https://generativelanguage.googleapis.com?x=1"]) {
    process.env.GEMINI_BASE_URL = bad;
    expect(() => veoBase(), bad).toThrow(VeoError);
  }
});

test("submit: one POST to the model's own address with the key in a header only, no redirect followed, the settings and images in the body, and the operation returned", async () => {
  const seen: Seen[] = [];
  const png = { bytes: Buffer.from("png-bytes"), mime: "image/png" };
  const result = await submitVideo(request({ firstFrame: png, negativePrompt: "text", seed: 7 }), { fetch: answer(200, { name: OP }, seen) });
  expect(result).toEqual({ operation: OP });
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning");
  expect(seen[0].init.method).toBe("POST");
  expect(seen[0].init.redirect).toBe("error");
  expect(seen[0].init.headers).toMatchObject({ "x-goog-api-key": KEY });
  expect(seen[0].url).not.toContain(KEY);
  const body = JSON.parse(String(seen[0].init.body));
  expect(JSON.stringify(body)).not.toContain(KEY);
  expect(body.instances[0]).toEqual({ prompt: "A paper boat on a puddle.", image: { bytesBase64Encoded: png.bytes.toString("base64"), mimeType: "image/png" } });
  expect(body.parameters).toEqual({ aspectRatio: "16:9", resolution: "720p", durationSeconds: 8, negativePrompt: "text", seed: 7 });
  /* References ride as references. */
  seen.length = 0;
  await submitVideo(request({ references: [png, png] }), { fetch: answer(200, { name: OP }, seen) });
  expect(JSON.parse(String(seen[0].init.body)).instances[0].referenceImages).toHaveLength(2);
});

test("submit: settings the vendor does not take never reach it (the request is not made), and a missing key is a clear refusal", async () => {
  const seen: Seen[] = [];
  await expect(submitVideo(request({ resolution: "1080p", durationSeconds: 4 }), { fetch: answer(200, { name: OP }, seen) })).rejects.toMatchObject({ rejectedBeforeGeneration: true });
  expect(seen).toHaveLength(0);
  delete process.env.GEMINI_API_KEY;
  await expect(submitVideo(request(), { fetch: answer(200, { name: OP }, seen) })).rejects.toThrow("GEMINI_API_KEY is needed");
  expect(seen).toHaveLength(0);
});

test("submit: a clear refusal (4xx but not 408) is safe to settle at nothing; 408, 5xx, no answer and a reply with no job are not, so the caller keeps the job open and never sends it twice", async () => {
  for (const status of [400, 403, 404, 422, 429]) await expect(submitVideo(request(), { fetch: answer(status, { error: { message: "no" } }) }), String(status)).rejects.toMatchObject({ status, rejectedBeforeGeneration: true });
  for (const status of [408, 500, 502, 503]) await expect(submitVideo(request(), { fetch: answer(status, "") }), String(status)).rejects.toMatchObject({ status, rejectedBeforeGeneration: false });
  const dropped = (async () => { throw new TypeError("fetch failed"); }) as never;
  await expect(submitVideo(request(), { fetch: dropped })).rejects.toMatchObject({ message: "Google did not answer.", rejectedBeforeGeneration: false });
  for (const body of [{}, { name: "" }, { name: "operations/x" }, { name: "models/../operations/x" }, { name: "https://evil.example/x" }, { name: 5 }, "not json"]) {
    await expect(submitVideo(request(), { fetch: answer(200, body) }), JSON.stringify(body)).rejects.toMatchObject({ message: "Google's reply named no job to poll.", rejectedBeforeGeneration: false });
  }
  /* A refusal's words are capped and never carry the key. */
  const long = await submitVideo(request(), { fetch: answer(400, { error: { message: "x".repeat(900) } }) }).catch((e: VeoError) => e);
  expect((long as VeoError).message.length).toBeLessThan(260);
});

test("poll: not done and anything we do not know is pending; a video address on googleapis.com is ready; an error, a safety filter or an address elsewhere is failed", async () => {
  const seen: Seen[] = [];
  const poll = (body: unknown, status = 200) => pollVideo({ operation: OP }, { fetch: answer(status, body, seen) });
  expect(await poll({ name: OP })).toEqual({ status: "pending" });
  expect(await poll({ done: false })).toEqual({ status: "pending" });
  expect(await poll({ done: "yes" })).toEqual({ status: "pending" });
  expect(seen[0].url).toBe(`https://generativelanguage.googleapis.com/v1beta/${OP}`);
  expect(seen[0].init.method).toBe("GET");
  expect(seen[0].init.redirect).toBe("error");
  expect(seen[0].init.headers).toMatchObject({ "x-goog-api-key": KEY });
  const uri = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";
  expect(await poll({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } })).toEqual({ status: "ready", resultUrl: uri });
  expect(await poll({ done: true, response: { generatedSamples: [{ video: { uri } }] } })).toEqual({ status: "ready", resultUrl: uri });
  expect(await poll({ done: true, error: { code: 13, message: "internal" } })).toEqual({ status: "failed", failure: "Google could not make this clip." });
  expect(await poll({ done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["blocked"] } } })).toEqual({ status: "failed", failure: "Google's safety filter stopped this." });
  expect(await poll({ done: true, response: {} })).toMatchObject({ status: "failed", failure: "Google's reply named no video we can fetch." });
  for (const elsewhere of ["https://example.com/v.mp4", "http://generativelanguage.googleapis.com/v.mp4", "https://googleapis.com.evil.example/v.mp4"]) {
    expect(await poll({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: elsewhere } }] } } }), elsewhere).toMatchObject({ status: "failed" });
  }
  /* A refused poll is an error for the caller, not a verdict; a 404 is a clear one. */
  await expect(poll({ error: { message: "gone" } }, 404)).rejects.toMatchObject({ status: 404, rejectedBeforeGeneration: true });
  await expect(poll({}, 503)).rejects.toMatchObject({ status: 503, rejectedBeforeGeneration: false });
  /* Only a name Google's shape allows is ever put in an address. */
  for (const operation of ["", "../x", "models/x/operations/y/../z", "https://evil.example/x", "models/x/operations/y?key=1"]) await expect(pollVideo({ operation }, { fetch: answer(200, {}) }), operation).rejects.toThrow(VeoError);
});

test("the result: fetched with the key, no redirect, only from googleapis.com, capped; empty or oversized is refused", async () => {
  const seen: Seen[] = [];
  const uri = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";
  const bytes = await fetchResult(uri, { fetch: (async (url: string, init: RequestInit) => { seen.push({ url: String(url), init }); return new Response(Buffer.from("mp4-bytes"), { status: 200 }); }) as never });
  expect(bytes.toString()).toBe("mp4-bytes");
  expect(seen[0].init.redirect).toBe("error");
  expect(seen[0].init.headers).toMatchObject({ "x-goog-api-key": KEY });
  expect(seen[0].url).not.toContain(KEY);
  const none: Seen[] = [];
  await expect(fetchResult("https://example.com/v.mp4", { fetch: answer(200, "x", none) })).rejects.toThrow("not one we fetch");
  await expect(fetchResult("http://generativelanguage.googleapis.com/v.mp4", { fetch: answer(200, "x", none) })).rejects.toThrow("not one we fetch");
  expect(none).toHaveLength(0);
  await expect(fetchResult(uri, { fetch: answer(200, "") })).rejects.toThrow("empty or too large");
  await expect(fetchResult(uri, { fetch: answer(404, "") })).rejects.toMatchObject({ status: 404 });
  const huge = (async () => new Response("x", { status: 200, headers: { "content-length": String(300 * 1024 * 1024) } })) as never;
  await expect(fetchResult(uri, { fetch: huge })).rejects.toThrow("larger than Particl keeps");
  /* A redirect is an error: the platform's fetch, asked not to follow, refuses. */
  const redirecting = (async (_u: string, init: RequestInit) => { if (init.redirect === "error") throw new TypeError("redirect mode is set to error"); return new Response("x"); }) as never;
  await expect(fetchResult(uri, { fetch: redirecting })).rejects.toMatchObject({ message: "The clip could not be fetched from Google." });
});

test("the fixture (ENGINE_MOCK=1): no request leaves the process; a job is pending then ready; a refusal and a filtered clip are available by prompt; the result is the fixture clip", async () => {
  process.env.ENGINE_MOCK = "1";
  delete process.env.GEMINI_API_KEY;
  const never = (async () => { throw new Error("no request may be made in a mock"); }) as never;
  const { operation } = await submitVideo(request(), { fetch: never });
  expect(operation).toMatch(/^models\/veo-3.1-generate-preview\/operations\/mock_veo_\d+$/);
  expect(await pollVideo({ operation }, { fetch: never })).toEqual({ status: "pending" });
  const ready = await pollVideo({ operation }, { fetch: never });
  expect(ready.status).toBe("ready");
  const bytes = await fetchResult(ready.resultUrl!, { fetch: never });
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
  await expect(submitVideo(request({ prompt: "[[mock-refuse]] x" }), { fetch: never })).rejects.toMatchObject({ rejectedBeforeGeneration: true });
  const filtered = await submitVideo(request({ prompt: "[[mock-filtered]] x" }), { fetch: never });
  await pollVideo(filtered, { fetch: never });
  expect(await pollVideo(filtered, { fetch: never })).toEqual({ status: "failed", failure: "Google's safety filter stopped this." });
  await expect(pollVideo({ operation: "models/veo-3.1-generate-preview/operations/mock_veo_nope" }, { fetch: never })).rejects.toMatchObject({ status: 404 });
  /* Settings are still checked in a mock: a fixture never accepts what the vendor would not. */
  await expect(submitVideo(request({ resolution: "1080p", durationSeconds: 4 }), { fetch: never })).rejects.toMatchObject({ rejectedBeforeGeneration: true });
});
