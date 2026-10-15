import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DEFAULT_ASTRA } from "../../lib/astra";
import { DEFAULT_TOPAZ_IMAGE } from "../../lib/topaz";
import {
  MOCK_TOPAZ_MP4, MOCK_TOPAZ_PNG, TOPAZ_RATES, TOPAZ_SWITCH, TopazError, acceptVideo, cancelImage, cancelVideo, completeVideoUpload, createVideoRequest, deleteImageCopy, deleteVideoMedia,
  downloadImage, downloadVideo, imageStatus, submitImageUpscale, topazCreditsUsd, topazHostUrl, topazImageCredits, topazImageQuoteUsd, topazSettleUsd, topazVideoCredits, topazVideoOutput,
  topazVideoQuoteUsd, topazVideoTierOf, uploadVideoParts, videoStatus,
} from "../../lib/topazDirect";

/* Topaz Labs' own API (lib/topazDirect.ts): the adapter alone, on a stand-in for fetch and on the in-process fixture. No network, no key, no spend. */
const KEY = "topaz-test-key-0123456789abcdef";
const saved = { key: process.env.TOPAZ_API_KEY, mock: process.env.ENGINE_MOCK };
test.beforeEach(() => { process.env.TOPAZ_API_KEY = KEY; process.env.ENGINE_MOCK = "0"; });
test.afterAll(() => { for (const [k, v] of [["TOPAZ_API_KEY", saved.key], ["ENGINE_MOCK", saved.mock]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: RequestRedirect | undefined };
function stub(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body, redirect: init.redirect };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const PNG = Buffer.from(MOCK_TOPAZ_PNG);

test("the table prices at Developer, $0.10 a credit, on the dearer reading everywhere, and says the owner is to confirm it", () => {
  expect(TOPAZ_RATES).toMatchObject({ plan: "developer", usdPerCredit: 0.1, confirmed: false });
  expect(TOPAZ_RATES.note).toContain("owner to confirm plan and reading against the first invoice");
  // Images by the API page's tiers: 24 MP 1 credit, 32 MP 2, 48 MP 3.
  expect([1, 24, 24.01, 32, 32.01, 48].map(topazImageCredits)).toEqual([1, 1, 2, 2, 3, 3]);
  expect(() => topazImageCredits(48.01)).toThrow(TopazError);
  expect(() => topazImageCredits(0)).toThrow(TopazError);
  expect(topazImageQuoteUsd(24)).toBe(0.1);
  expect(topazImageQuoteUsd(48)).toBe(0.3);
  // Astra 2: 4 credits a second at 1080p30 (the family table), 5 at 4K30; 60 fps doubles; 720p is the 1080p tier.
  expect(topazVideoCredits({ seconds: 10, fps: 30, tier: "1080p" })).toBe(40);
  expect(topazVideoCredits({ seconds: 10, fps: 60, tier: "1080p" })).toBe(80);
  expect(topazVideoCredits({ seconds: 5, fps: 30, tier: "4k" })).toBe(25);
  expect(topazVideoCredits({ seconds: 5, fps: 60, tier: "4k" })).toBe(50);
  expect(topazVideoCredits({ seconds: 0.1, fps: 30, tier: "1080p" })).toBe(1);
  expect(topazVideoCredits({ seconds: 1.5, fps: 24, tier: "1080p" })).toBe(5);
  expect(topazVideoQuoteUsd({ seconds: 5, fps: 30, tier: "4k" })).toBe(2.5);
  expect([720, 1080].map(topazVideoTierOf)).toEqual(["1080p", "1080p"]);
  expect([1081, 2160].map(topazVideoTierOf)).toEqual(["4k", "4k"]);
  for (const bad of [{ seconds: 0, fps: 30 }, { seconds: 5, fps: 0 }, { seconds: NaN, fps: 30 }]) expect(() => topazVideoCredits({ ...bad, tier: "4k" })).toThrow(TopazError);
  expect(topazCreditsUsd(3)).toBe(0.3);
  // Never under what the invoice can be: the 14 Oct plan's 7.7 frames a credit at 1080p (19.5 credits for 5 s) is below the family table's 20.
  expect(topazVideoCredits({ seconds: 5, fps: 30, tier: "1080p" })).toBeGreaterThanOrEqual(19.5);
});

test("a job settles at what Topaz says it used and never above its quote; no word from Topaz is not a figure", () => {
  expect(topazSettleUsd(11, 2.5)).toEqual({ usd: 1.1, capped: false });
  expect(topazSettleUsd(25, 2.5)).toEqual({ usd: 2.5, capped: false });
  expect(topazSettleUsd(26, 2.5)).toEqual({ usd: 2.5, capped: true });
  for (const none of [null, undefined, NaN, -1, Infinity]) expect(topazSettleUsd(none as never, 2.5)).toBeNull();
});

test("only Topaz's own hosts and its storage are ever fetched, as https with no port and no credentials", () => {
  for (const ok of ["https://api.topazlabs.com/x", "https://topazlabs.com/x", "https://dl.topazlabs.com/a?b=1", "https://bucket.s3.amazonaws.com/k", "https://bucket.s3.us-west-2.amazonaws.com/k", "https://s3.amazonaws.com/b/k", "https://bucket.s3-eu-west-1.amazonaws.com/k"]) expect(topazHostUrl(ok)?.href, ok).toBe(ok);
  for (const bad of ["http://api.topazlabs.com/x", "https://api.topazlabs.com:8443/x", "https://u:p@api.topazlabs.com/x", "https://topazlabs.com.evil.test/x", "https://eviltopazlabs.com/x", "https://amazonaws.com/x", "https://ec2.amazonaws.com/x", "https://x.s3.evil.test/x", "https://evil.test/?h=api.topazlabs.com", "file:///etc/passwd", "ftp://api.topazlabs.com/x", "not a url", "", null, undefined, 5, "https://" + "a".repeat(5000) + ".topazlabs.com"]) expect(topazHostUrl(bad), String(bad)).toBeNull();
});

test("every request goes to the one fixed address with the key in its header only, refuses redirects, and is made once", async () => {
  const s = stub(() => json({ process_id: "p1" }));
  await submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: 1000, height: 500, settings: DEFAULT_TOPAZ_IMAGE }, { fetch: s.fetch });
  expect(s.calls).toHaveLength(1);
  const [c] = s.calls;
  expect(c.url).toBe("https://api.topazlabs.com/image/v1/enhance/async");
  expect(c.headers["x-api-key"]).toBe(KEY);
  expect(c.redirect).toBe("error");
  expect(c.url).not.toContain(KEY);
  expect(c.method).toBe("POST");
  // A request that is not answered, answered with a failure, or answered oddly is thrown once and never sent again.
  for (const answer of [() => { throw new TypeError("fetch failed: " + KEY); }, () => json({}, 500), () => json({ message: "no" }, 503), () => json({ nothing: true })]) {
    const f = stub(answer);
    const error = await submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: 1000, height: 500, settings: DEFAULT_TOPAZ_IMAGE }, { fetch: f.fetch }).catch((e) => e);
    expect(error).toBeInstanceOf(TopazError);
    expect(f.calls).toHaveLength(1);
    expect(error.message).not.toContain(KEY);
  }
  // A 4xx before work says nothing was taken; a 5xx, a 408 and a 429 do not.
  expect(await submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: 10, height: 10, settings: DEFAULT_TOPAZ_IMAGE }, { fetch: stub(() => json({ message: "bad" }, 400)).fetch }).catch((e) => e)).toMatchObject({ status: 400, rejectedBeforeWork: true });
  for (const status of [408, 429, 500, 502]) expect(await submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: 10, height: 10, settings: DEFAULT_TOPAZ_IMAGE }, { fetch: stub(() => json({}, status)).fetch }).catch((e) => e)).toMatchObject({ status, rejectedBeforeWork: false });
  // No key: nothing is sent.
  delete process.env.TOPAZ_API_KEY;
  const none = stub(() => json({}));
  await expect(submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: 10, height: 10, settings: DEFAULT_TOPAZ_IMAGE }, { fetch: none.fetch })).rejects.toThrow("TOPAZ_API_KEY");
  expect(none.calls).toHaveLength(0);
});

test("a still: the settings are today's presets, the output size is the original's times the scale, the form says so, and an unsupported choice is refused before anything is sent", async () => {
  const s = stub(() => json({ process_id: "p_img_1" }));
  const out = await submitImageUpscale({ bytes: PNG, filename: "photo.png", mime: "image/png", width: 2000, height: 1000, settings: { model: "Text Refine", factor: 4, faceEnhancement: true, faceStrength: 0.7 } }, { fetch: s.fetch });
  expect(out).toEqual({ id: "p_img_1", outputMegapixels: 32, credits: 2 });
  const form = s.calls[0].body as FormData;
  expect(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string"))).toEqual({ model: "Text Refine", output_format: "png", output_width: "8000", output_height: "4000", crop_to_fill: "false", face_enhancement: "true", face_enhancement_strength: "0.7", face_enhancement_creativity: "0" });
  const file = form.get("image") as File;
  expect(file.name).toBe("photo.png");
  expect(file.type).toBe("image/png");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  // The settings the panel offers, and nothing else.
  for (const settings of [{ ...DEFAULT_TOPAZ_IMAGE, model: "Standard V3" }, { ...DEFAULT_TOPAZ_IMAGE, factor: 3 }, { ...DEFAULT_TOPAZ_IMAGE, faceStrength: 2 }, null, "x"]) {
    const refused = stub(() => json({ process_id: "x" }));
    await expect(submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: 100, height: 100, settings: settings as never }, { fetch: refused.fetch })).rejects.toThrow();
    expect(refused.calls).toHaveLength(0);
  }
  // A size the original cannot be made (over 48 MP), or no size, is refused too.
  for (const dims of [[6000, 4000, 2], [0, 100, 1]]) {
    const refused = stub(() => json({}));
    await expect(submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: dims[0], height: dims[1], settings: { ...DEFAULT_TOPAZ_IMAGE, factor: dims[2] as 1 | 2 | 4 } }, { fetch: refused.fetch })).rejects.toThrow();
    expect(refused.calls).toHaveLength(0);
  }
});

test("a still's status and download: an unknown word is still processing, the output is the picture or an address on Topaz's own hosts, and nothing else is fetched", async () => {
  const status = (reply: Record<string, unknown>) => imageStatus("p1", { fetch: stub(() => json(reply)).fetch });
  expect(await status({ status: "Processing" })).toEqual({ id: "p1", status: "processing" });
  expect(await status({ status: "Completed", credits: 1 })).toEqual({ id: "p1", status: "completed", credits: 1 });
  expect(await status({ status: "Failed", message: "bad input" })).toEqual({ id: "p1", status: "failed", error: "bad input" });
  expect(await status({ status: "Cancelled" })).toMatchObject({ status: "cancelled" });
  expect(await status({ status: "warming up" })).toMatchObject({ status: "processing" });
  expect(await status({ status: "completed", credits: -3 })).toEqual({ id: "p1", status: "completed" });
  // Download: the picture itself.
  const direct = stub(() => new Response(new Uint8Array(PNG), { headers: { "content-type": "image/png" } }));
  expect(await downloadImage("p1", { fetch: direct.fetch })).toEqual(PNG);
  expect(direct.calls.map((c) => [c.method, c.url, c.headers["x-api-key"], c.redirect])).toEqual([["GET", "https://api.topazlabs.com/image/v1/download/p1", KEY, "error"]]);
  // Download: an address, on Topaz's host, fetched without the key.
  const viaUrl = stub((c) => (c.url.includes("/image/v1/download/") ? json({ download_url: "https://bucket.s3.amazonaws.com/out.png?sig=1" }) : new Response(new Uint8Array(PNG), { headers: { "content-type": "image/png" } })));
  expect(await downloadImage("p1", { fetch: viaUrl.fetch })).toEqual(PNG);
  expect(viaUrl.calls[1].headers["x-api-key"]).toBeUndefined();
  expect(viaUrl.calls[1].redirect).toBe("error");
  // An address elsewhere is never fetched; an empty or failing answer is a failure.
  const elsewhere = stub(() => json({ download_url: "https://evil.test/out.png" }));
  await expect(downloadImage("p1", { fetch: elsewhere.fetch })).rejects.toThrow("no upscaled image we can download");
  expect(elsewhere.calls).toHaveLength(1);
  await expect(downloadImage("p1", { fetch: stub(() => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } })).fetch })).rejects.toThrow("empty or too large");
  await expect(downloadImage("p1", { fetch: stub(() => json({}, 404)).fetch })).rejects.toBeInstanceOf(TopazError);
  await expect(downloadImage("p1", { fetch: stub(() => new Response("x", { headers: { "content-type": "image/png", "content-length": String(500 * 1024 * 1024) } })).fetch })).rejects.toThrow("larger than Particl keeps");
});

test("cancelling and deleting: a still cancels by its id, its copy has no endpoint to call, and a clip's copy and request are deleted by the paths Topaz names; a missing one is already gone", async () => {
  const s = stub(() => json({}));
  expect(await cancelImage("p1", { fetch: s.fetch })).toBe(true);
  expect(await deleteVideoMedia("r1", { fetch: s.fetch })).toBe(true);
  expect(await cancelVideo("r1", { fetch: s.fetch })).toBe(true);
  expect(s.calls.map((c) => `${c.method} ${c.url.replace("https://api.topazlabs.com", "")}`)).toEqual(["DELETE /image/v1/cancel/p1", "DELETE /video/r1/media", "DELETE /video/r1"]);
  const gone = stub(() => json({}, 404));
  expect(await cancelImage("p1", { fetch: gone.fetch })).toBe(true);
  expect(await deleteVideoMedia("r1", { fetch: gone.fetch })).toBe(true);
  expect(await cancelVideo("r1", { fetch: gone.fetch })).toBe(true);
  await expect(deleteVideoMedia("r1", { fetch: stub(() => json({}, 500)).fetch })).rejects.toBeInstanceOf(TopazError);
  // Topaz's image API names no delete: the copy is Topaz's to expire, and the adapter says so rather than guess a URL.
  expect(await deleteImageCopy("p1")).toBe(false);
});

test("a clip: the request carries the source and Astra 2's controls and asks for 4K at the chosen frame rate; the estimate is read; the paid step is the completed upload, once", async () => {
  const source = { container: "mp4" as const, sizeBytes: 12_345_678, durationSeconds: 5, frameRate: 30, width: 1920, height: 1080 };
  const s = stub((c) => {
    if (c.url.endsWith("/video/")) return json({ requestId: "r1", estimates: { cost: [18, 25], time: [60, 90] } });
    if (c.url.endsWith("/accept")) return json({ urls: ["https://bucket.s3.amazonaws.com/p1?sig=a", "https://bucket.s3.amazonaws.com/p2?sig=b"] });
    if (c.method === "PUT") return new Response(null, { status: 200, headers: { etag: `"tag-${c.url.includes("p1") ? 1 : 2}"` } });
    return json({});
  });
  const created = await createVideoRequest({ source, settings: { creativity: 0.3, realism: 0.6, sharpness: 0.9, fps: 60 } }, { fetch: s.fetch });
  expect(created).toEqual({ id: "r1", estimatedCredits: { low: 18, high: 25 }, output: { width: 3840, height: 2160, frameRate: 60 } });
  expect(JSON.parse(String(s.calls[0].body))).toEqual({
    source: { container: "mp4", size: 12345678, duration: 5, frameRate: 30, resolution: { width: 1920, height: 1080 } },
    filters: [{ model: "ast-2", creativity: 0.3, realism: 0.6, sharpness: 0.9 }],
    output: { resolution: { width: 3840, height: 2160 }, frameRate: 60, audioTransfer: "Copy", audioCodec: "AAC", videoEncoder: "H264", videoProfile: "High", container: "mp4" },
  });
  const { uploadUrls } = await acceptVideo("r1", { fetch: s.fetch });
  expect(uploadUrls).toHaveLength(2);
  const bytes = Buffer.alloc(10, 7);
  const parts = await uploadVideoParts(uploadUrls, bytes, { fetch: s.fetch });
  expect(parts).toEqual([{ partNum: 1, eTag: "tag-1" }, { partNum: 2, eTag: "tag-2" }]);
  const puts = s.calls.filter((c) => c.method === "PUT");
  expect(puts.map((c) => (c.body as Uint8Array).length)).toEqual([5, 5]);
  expect(puts.every((c) => c.headers["x-api-key"] === undefined && c.redirect === "error")).toBe(true);
  await completeVideoUpload("r1", parts, { fetch: s.fetch });
  const done = s.calls.at(-1)!;
  expect([done.method, done.url, JSON.parse(String(done.body))]).toEqual(["PATCH", "https://api.topazlabs.com/video/r1/complete-upload", { uploadResults: [{ partNum: 1, eTag: "tag-1" }, { partNum: 2, eTag: "tag-2" }] }]);
  expect(s.calls.filter((c) => c.url.endsWith("/complete-upload"))).toHaveLength(1);
  // The controls are today's (lib/astra.ts): anything outside them is refused before a request is sent.
  const refused = stub(() => json({ requestId: "x" }));
  for (const settings of [{ ...DEFAULT_ASTRA, fps: 24 }, { ...DEFAULT_ASTRA, creativity: 2 }, null]) await expect(createVideoRequest({ source, settings: settings as never }, { fetch: refused.fetch })).rejects.toThrow();
  for (const bad of [{ ...source, durationSeconds: 0 }, { ...source, sizeBytes: NaN }, { ...source, height: 0 }]) await expect(createVideoRequest({ source: bad, settings: DEFAULT_ASTRA }, { fetch: refused.fetch })).rejects.toThrow();
  expect(refused.calls).toHaveLength(0);
  expect(topazVideoOutput({ width: 720, height: 1280 }, DEFAULT_ASTRA)).toEqual({ width: 1216, height: 2160, frameRate: 30 });
  expect(topazVideoOutput({ width: 480, height: 270 }, DEFAULT_ASTRA)).toEqual({ width: 1920, height: 1080, frameRate: 30 });
});

test("upload addresses that are not Topaz's are refused before any byte is sent; a part that is not taken, or not tagged, fails the upload and is not retried", async () => {
  const s = stub(() => new Response(null, { status: 200, headers: { etag: '"t"' } }));
  await expect(acceptVideo("r1", { fetch: stub(() => json({ urls: ["https://evil.test/up"] })).fetch })).rejects.toThrow("upload addresses");
  await expect(acceptVideo("r1", { fetch: stub(() => json({ urls: [] })).fetch })).rejects.toThrow("upload addresses");
  await expect(acceptVideo("r1", { fetch: stub(() => json({ urls: ["https://bucket.s3.amazonaws.com/a", "http://bucket.s3.amazonaws.com/b"] })).fetch })).rejects.toThrow("upload addresses");
  await expect(uploadVideoParts(["https://evil.test/up"], Buffer.alloc(4), { fetch: s.fetch })).rejects.toThrow("not one Topaz's storage uses");
  expect(s.calls).toHaveLength(0);
  const failing = stub(() => new Response(null, { status: 403 }));
  await expect(uploadVideoParts(["https://b.s3.amazonaws.com/a", "https://b.s3.amazonaws.com/b"], Buffer.alloc(4), { fetch: failing.fetch })).rejects.toThrow("did not take the upload");
  expect(failing.calls).toHaveLength(1);
  await expect(uploadVideoParts(["https://b.s3.amazonaws.com/a"], Buffer.alloc(4), { fetch: stub(() => new Response(null, { status: 200 })).fetch })).rejects.toThrow("did not name an uploaded part");
  await expect(uploadVideoParts([], Buffer.alloc(4))).rejects.toThrow("nothing to upload");
  await expect(completeVideoUpload("r1", [])).rejects.toThrow("no uploaded parts");
});

test("a clip's status: Topaz's words map to ours, an unknown one is processing, the output address is kept only on Topaz's hosts, and the download is capped and fetched without the key", async () => {
  const poll = (reply: Record<string, unknown>) => videoStatus("r1", { fetch: stub(() => json(reply)).fetch });
  for (const [word, ours] of [["requested", "pending"], ["accepted", "pending"], ["initializing", "pending"], ["preprocessing", "pending"], ["processing", "processing"], ["postprocessing", "processing"], ["canceling", "processing"], ["complete", "completed"], ["failed", "failed"], ["canceled", "cancelled"], ["warming up", "processing"]] as const) expect((await poll({ status: word })).status, word).toBe(ours);
  expect(await poll({ status: "processing", progress: 40 })).toEqual({ id: "r1", status: "processing", progress: 0.4 });
  expect(await poll({ status: "Complete", download: { url: "https://dl.topazlabs.com/o.mp4" }, credits: 24 })).toEqual({ id: "r1", status: "completed", downloadUrl: "https://dl.topazlabs.com/o.mp4", credits: 24 });
  expect((await poll({ status: "complete", download: { url: "https://evil.test/o.mp4" } })).downloadUrl).toBeUndefined();
  expect(await poll({ status: "failed", message: "unsupported codec" })).toMatchObject({ status: "failed", error: "unsupported codec" });
  const dl = stub(() => new Response(new Uint8Array(MOCK_TOPAZ_MP4), { headers: { "content-type": "video/mp4" } }));
  expect(await downloadVideo({ id: "r1", url: "https://dl.topazlabs.com/o.mp4" }, { fetch: dl.fetch })).toEqual(MOCK_TOPAZ_MP4);
  expect(dl.calls.map((c) => [c.headers["x-api-key"], c.redirect])).toEqual([[undefined, "error"]]);
  await expect(downloadVideo({ id: "r1", url: "https://evil.test/o.mp4" }, { fetch: dl.fetch })).rejects.toThrow("no upscaled clip we can download");
  await expect(downloadVideo({ id: "r1" }, { fetch: dl.fetch })).rejects.toBeInstanceOf(TopazError);
  expect(dl.calls).toHaveLength(1);
});

test("the fixture (ENGINE_MOCK=1): a still and a clip run end to end in process, with no fetch at all, no key, and the same shapes", async () => {
  process.env.ENGINE_MOCK = "1";
  delete process.env.TOPAZ_API_KEY;
  const never = { fetch: (async () => { throw new Error("no network under the fixture"); }) as typeof fetch };
  const img = await submitImageUpscale({ bytes: PNG, filename: "a.png", mime: "image/png", width: 3000, height: 2000, settings: DEFAULT_TOPAZ_IMAGE }, never);
  expect(img).toMatchObject({ outputMegapixels: 24, credits: 1 });
  expect((await imageStatus(img.id, never)).status).toBe("processing");
  expect(await imageStatus(img.id, never)).toEqual({ id: img.id, status: "completed", credits: 1 });
  expect(await downloadImage(img.id, never)).toEqual(MOCK_TOPAZ_PNG);
  expect(await cancelImage(img.id, never)).toBe(true);
  await expect(imageStatus("nope", never)).rejects.toMatchObject({ status: 404, rejectedBeforeWork: true });
  const source = { container: "mp4" as const, sizeBytes: 1000, durationSeconds: 5, frameRate: 30, width: 1920, height: 1080 };
  const vid = await createVideoRequest({ source, settings: DEFAULT_ASTRA }, never);
  expect(vid.estimatedCredits).toEqual({ low: 24, high: 25 });
  await expect(completeVideoUpload(vid.id, [{ partNum: 1, eTag: "x" }], never)).rejects.toMatchObject({ status: 409 });
  const { uploadUrls } = await acceptVideo(vid.id, never);
  const parts = await uploadVideoParts(uploadUrls, Buffer.alloc(8), never);
  await completeVideoUpload(vid.id, parts, never);
  expect((await videoStatus(vid.id, never)).status).toBe("processing");
  const done = await videoStatus(vid.id, never);
  expect(done).toMatchObject({ status: "completed", credits: 25 });
  expect(topazHostUrl(done.downloadUrl)).not.toBeNull();
  expect(await downloadVideo({ id: vid.id, url: done.downloadUrl }, never)).toEqual(MOCK_TOPAZ_MP4);
  expect(await deleteVideoMedia(vid.id, never)).toBe(true);
  expect(await cancelVideo(vid.id, never)).toBe(true);
  await expect(videoStatus(vid.id, never)).rejects.toMatchObject({ status: 404 });
});

test("the module is the adapter alone: nothing imports it yet, it reads no setting but the key, names its switch, and holds no vendor figure of anyone else's", () => {
  const source = readFileSync("lib/topazDirect.ts", "utf8");
  const env = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  expect([...new Set(env)]).toEqual(["TOPAZ_API_KEY"]);
  expect(TOPAZ_SWITCH).toBe("TOPAZ_DIRECT_ENABLED");
  expect(source).not.toMatch(/vendorRates|fal\.ai|FAL_KEY|\bnext\/|use client/);
  for (const file of ["lib/topaz.ts", "lib/astra.ts", "lib/jobs.ts", "lib/models.ts", "lib/providers.ts"]) expect(readFileSync(file, "utf8"), file).not.toContain("topazDirect");
});
