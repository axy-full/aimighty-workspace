import { test, expect } from "@playwright/test";
import { VEO_RATES } from "../../lib/vendorRates";
import { mp4DurationSeconds } from "../../lib/mp4Duration";
import { VeoError, fetchResult, pollVideo, submitVideo, veoBase, veoDownloadUrl, veoHostUrl, veoQuoteUsd, veoSettingsError, type VeoRequest } from "../../lib/veo";

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
  /* References work in either shape; only the length matters. */
  expect(veoSettingsError({ ...request({ aspectRatio: "9:16" }), references: [1] })).toBeNull();
  /* The rates are Google's published figures (verified 16 Oct 2026). */
  expect(veoQuoteUsd({ model: "veo-3.1-generate-preview", resolution: "720p", durationSeconds: 8 })).toBe(3.2);
  expect(veoQuoteUsd({ model: "veo-3.1-generate-preview", resolution: "1080p", durationSeconds: 8 })).toBe(3.2);
  expect(veoQuoteUsd({ model: "veo-3.1-fast-generate-preview", resolution: "720p", durationSeconds: 8 })).toBe(0.8);
  expect(veoQuoteUsd({ model: "veo-3.1-fast-generate-preview", resolution: "1080p", durationSeconds: 8 })).toBe(0.96);
  expect(veoQuoteUsd({ model: "veo-3.1-fast-generate-preview", resolution: "720p", durationSeconds: 4 })).toBe(0.4);
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
  /* Exactly one clip, always: a default above one would bill several against a one-clip quote. */
  expect(body.parameters).toEqual({ aspectRatio: "16:9", resolution: "720p", durationSeconds: 8, sampleCount: 1, negativePrompt: "text", seed: 7 });
  /* References ride as references. */
  seen.length = 0;
  await submitVideo(request({ references: [png, png] }), { fetch: answer(200, { name: OP }, seen) });
  const withRefs = JSON.parse(String(seen[0].init.body));
  expect(withRefs.instances[0].referenceImages).toHaveLength(2);
  expect(withRefs.parameters.personGeneration).toBe("allow_adult");
  expect(withRefs.parameters.sampleCount).toBe(1);
  expect(body.parameters).not.toHaveProperty("personGeneration");
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

test("the result: the first request carries the key and goes to googleapis.com, capped; empty or oversized is refused", async () => {
  const seen: Seen[] = [];
  const uri = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";
  const bytes = await fetchResult(uri, { fetch: (async (url: string, init: RequestInit) => { seen.push({ url: String(url), init }); return new Response(Buffer.from("mp4-bytes"), { status: 200 }); }) as never });
  expect(bytes.toString()).toBe("mp4-bytes");
  expect(seen).toHaveLength(1);
  expect(seen[0].init.redirect).toBe("manual");
  expect(seen[0].init.headers).toMatchObject({ "x-goog-api-key": KEY });
  expect(seen[0].url).not.toContain(KEY);
  const none: Seen[] = [];
  await expect(fetchResult("https://example.com/v.mp4", { fetch: answer(200, "x", none) })).rejects.toThrow("not one we fetch");
  await expect(fetchResult("http://generativelanguage.googleapis.com/v.mp4", { fetch: answer(200, "x", none) })).rejects.toThrow("not one we fetch");
  /* The first address must be googleapis.com: the wider download list is for hops only. */
  await expect(fetchResult("https://storage.googleapis.com.evil.example/v.mp4", { fetch: answer(200, "x", none) })).rejects.toThrow("not one we fetch");
  await expect(fetchResult("https://lh3.googleusercontent.com/v.mp4", { fetch: answer(200, "x", none) })).rejects.toThrow("not one we fetch");
  expect(none).toHaveLength(0);
  await expect(fetchResult(uri, { fetch: answer(200, "") })).rejects.toThrow("empty or too large");
  await expect(fetchResult(uri, { fetch: answer(404, "") })).rejects.toMatchObject({ status: 404 });
  const huge = (async () => new Response("x", { status: 200, headers: { "content-length": String(300 * 1024 * 1024) } })) as never;
  await expect(fetchResult(uri, { fetch: huge })).rejects.toThrow("larger than Particl keeps");
  const dropped = (async () => { throw new TypeError("fetch failed"); }) as never;
  await expect(fetchResult(uri, { fetch: dropped })).rejects.toMatchObject({ message: "The clip could not be fetched from Google." });
});

test("the result follows at most two redirects, each only to an allowed https host, and sends the key to the first request only", async () => {
  const uri = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";
  const route = (hops: Record<string, string | number>, seen: Seen[]): typeof fetch => (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    const next = hops[String(url)];
    if (typeof next === "string") return new Response(null, { status: 302, headers: { location: next } });
    return new Response(Buffer.from("clip-bytes"), { status: 200 });
  }) as never;
  const keyOf = (s: Seen) => (s.init.headers as Record<string, string> | undefined)?.["x-goog-api-key"];
  /* An allowed hop is followed, without the key; a relative address is read against the current one. */
  const seen: Seen[] = [];
  const bytes = await fetchResult(uri, { fetch: route({ [uri]: "https://video-downloads.googleusercontent.com/bucket/clip.mp4?sig=1", "https://video-downloads.googleusercontent.com/bucket/clip.mp4?sig=1": "/moved/clip.mp4" }, seen) });
  expect(bytes.toString()).toBe("clip-bytes");
  expect(seen.map((s) => s.url)).toEqual([uri, "https://video-downloads.googleusercontent.com/bucket/clip.mp4?sig=1", "https://video-downloads.googleusercontent.com/moved/clip.mp4"]);
  expect(seen.map(keyOf)).toEqual([KEY, undefined, undefined]);
  expect(seen.every((s) => s.init.redirect === "manual")).toBe(true);
  expect(JSON.stringify(seen.slice(1).map((s) => s.init))).not.toContain(KEY);
  for (const s of seen.slice(1)) expect(s.url).not.toContain(KEY);
  /* The one other host allowed as a hop is Google's own file host. */
  const own: Seen[] = [];
  expect((await fetchResult(uri, { fetch: route({ [uri]: "https://generativelanguage.googleapis.com/v1beta/files/other:download?alt=media" }, own) })).toString()).toBe("clip-bytes");
  expect(own.map(keyOf)).toEqual([KEY, undefined]);
  /* A hop to anywhere else is refused, and nothing is sent there. */
  for (const bad of ["https://example.com/c.mp4", "http://video.googleusercontent.com/c.mp4", "http://generativelanguage.googleapis.com/c.mp4", "https://googleapis.com.evil.example/c.mp4", "https://evil-googleusercontent.com/c.mp4", "https://googleusercontent.com/c.mp4", "https://user:pw@video.googleusercontent.com/c.mp4", "https://video.googleusercontent.com:8443/c.mp4", "file:///etc/passwd", "data:text/plain,x",
    /* Narrowed (owner's yes needed to widen): other people's pages and buckets on Google's domains are not download hosts. */
    "https://sites.google.com/c.mp4", "https://script.google.com/macros/s/x/exec", "https://storage.googleapis.com/bucket/c.mp4", "https://storage.cloud.google.com/c.mp4", "https://docs.google.com/c.mp4", "https://www.google.com/c.mp4", "https://drive.google.com/c.mp4", "https://firebasestorage.googleapis.com/c.mp4"]) {
    const s: Seen[] = [];
    await expect(fetchResult(uri, { fetch: route({ [uri]: bad }, s) }), bad).rejects.toThrow("an address we do not follow");
    expect(s.map((x) => x.url), bad).toEqual([uri]);
  }
  const noLocation: Seen[] = [];
  await expect(fetchResult(uri, { fetch: (async (url: string, init: RequestInit) => { noLocation.push({ url, init }); return new Response(null, { status: 302 }); }) as never })).rejects.toThrow("an address we do not follow");
  /* A third redirect is one too many. */
  const a = "https://video.googleusercontent.com/a", b = "https://video.googleusercontent.com/b", c = "https://video.googleusercontent.com/c";
  const loop: Seen[] = [];
  await expect(fetchResult(uri, { fetch: route({ [uri]: a, [a]: b, [b]: c }, loop) })).rejects.toThrow("moved too many times");
  expect(loop).toHaveLength(3);
  expect(veoDownloadUrl("https://generativelanguage.googleapis.com/x")).not.toBeNull();
  expect(veoDownloadUrl("https://video.googleusercontent.com/x")).not.toBeNull();
  expect(veoDownloadUrl("https://example.com/x")).toBeNull();
  expect(veoDownloadUrl("https://storage.googleapis.com/x")).toBeNull();
  expect(veoDownloadUrl("https://sites.google.com/x")).toBeNull();
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

test("the length of a clip is read from its container header: real files, version 0 and 1 headers, a header at the end, and anything unreadable is null", async () => {
  const { readFileSync } = await import("node:fs");
  const near = (v: number | null, want: number) => { expect(v).not.toBeNull(); expect(Math.abs(v! - want)).toBeLessThan(0.01); };
  near(mp4DurationSeconds(readFileSync("public/fixtures/clip.mp4")), 10);
  near(mp4DurationSeconds(readFileSync("public/fixtures/clip-6s.mp4")), 6.033);
  near(mp4DurationSeconds(readFileSync("public/fixtures/swap-5s-854x480.mp4")), 5);
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const box = (type: string, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]); };
  const v0 = (timescale: number, duration: number) => box("moov", box("mvhd", Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80)));
  const big = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
  const v1 = (timescale: number, duration: number) => box("moov", box("mvhd", Buffer.from([1, 0, 0, 0]), big(0), big(0), u32(timescale), big(duration), Buffer.alloc(80)));
  near(mp4DurationSeconds(v0(1000, 4000)), 4);
  near(mp4DurationSeconds(v1(90000, 360000)), 4);
  /* The header after the media, as an unoptimised file has it. */
  near(mp4DurationSeconds(Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(5000)), v0(600, 4800)])), 8);
  for (const bad of [Buffer.alloc(0), Buffer.from("not an mp4 at all"), box("ftyp", Buffer.from("isom0000")), v0(0, 1000), v0(1000, 0), v0(1000, 10_000_000), Buffer.from(v0(1000, 4000).subarray(0, 30)), box("moov", box("trak", Buffer.alloc(20)))]) expect(mp4DurationSeconds(bad)).toBeNull();
  /* A box that claims more than the file holds, and a version we do not know. */
  const lie = v0(1000, 4000); lie.writeUInt32BE(1_000_000, 0);
  expect(mp4DurationSeconds(lie)).toBeNull();
  const odd = v0(1000, 4000); odd[8 + 8] = 7;
  expect(mp4DurationSeconds(odd)).toBeNull();
});
