import { test, expect } from "@playwright/test";
import { VISION_ENDPOINT, VISION_IMAGE_LIMIT_BYTES, VISION_MAX_WORDS, VisionError, detectText, visionConfigured } from "../../lib/vision";
import { VISION_RATES } from "../../lib/vendorRates";

/**
 * The Cloud Vision adapter (lib/vision.ts) alone: no database, no route, no money. Every call is a function this file hands the adapter, or the in-process fixture under
 * ENGINE_MOCK=1; no request leaves this process and no provider is paid.
 */
const KEY = "unit-test-vision-key-not-real";
test.beforeEach(() => { process.env.GOOGLE_VISION_API_KEY = KEY; process.env.ENGINE_MOCK = ""; });
test.afterEach(() => { delete process.env.GOOGLE_VISION_API_KEY; process.env.ENGINE_MOCK = "1"; });

type Seen = { url: string; init: RequestInit };
const answer = (status: number, body: unknown, seen: Seen[] = []): typeof fetch => (async (url: string, init: RequestInit) => { seen.push({ url: String(url), init }); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); }) as never;
const png = Buffer.from("picture-bytes");

test("the price is the plan's: one image, one request; the rate is a single number with its margin key", () => {
  expect(VISION_RATES.textDetectionUsdPerImage).toBe(0.0015);
  expect(VISION_RATES.model).toBe("vision-text-detection");
});

test("one POST to the fixed Vision address with the key in a header only, no redirect followed, the picture as base64 and the TEXT_DETECTION feature", async () => {
  const seen: Seen[] = [];
  const out = await detectText({ bytes: png }, { fetch: answer(200, { responses: [{ textAnnotations: [{ description: "ACME COLA\n330 ml\n" }] }] }, seen) });
  expect(out.text).toBe("ACME COLA\n330 ml\n");
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe("https://vision.googleapis.com/v1/images:annotate");
  expect(seen[0].url).toBe(VISION_ENDPOINT);
  expect(seen[0].url).not.toContain(KEY);
  expect(seen[0].init.method).toBe("POST");
  expect(seen[0].init.redirect).toBe("error");
  expect(seen[0].init.headers).toMatchObject({ "x-goog-api-key": KEY });
  const body = JSON.parse(String(seen[0].init.body));
  expect(body).toEqual({ requests: [{ image: { content: png.toString("base64") }, features: [{ type: "TEXT_DETECTION" }] }] });
  expect(JSON.stringify(body)).not.toContain(KEY);
});

test("the words come with their boxes, capped; no text in the picture is an answer, not a failure", async () => {
  const word = (text: string, x: number) => ({ description: text, boundingPoly: { vertices: [{ x, y: 5 }, { x: x + 20, y: 5 }, { x: x + 20, y: 15 }, { x, y: 15 }] } });
  const out = await detectText({ bytes: png }, { fetch: answer(200, { responses: [{ textAnnotations: [{ description: "ACME COLA" }, word("ACME", 10), word("COLA", 40), { description: 5 }, { boundingPoly: {} }] }] }) });
  expect(out.words).toEqual([{ text: "ACME", box: [10, 5, 30, 15] }, { text: "COLA", box: [40, 5, 60, 15] }]);
  const many = [{ description: "w" }, ...Array.from({ length: VISION_MAX_WORDS + 50 }, (_, i) => word(`w${i}`, i))];
  expect((await detectText({ bytes: png }, { fetch: answer(200, { responses: [{ textAnnotations: many }] }) })).words).toHaveLength(VISION_MAX_WORDS);
  /* A word with no box keeps a zero box; vertices with missing coordinates read as 0. */
  expect((await detectText({ bytes: png }, { fetch: answer(200, { responses: [{ textAnnotations: [{ description: "A" }, { description: "A" }] }] }) })).words).toEqual([{ text: "A", box: [0, 0, 0, 0] }]);
  expect(await detectText({ bytes: png }, { fetch: answer(200, { responses: [{}] }) })).toEqual({ text: "", words: [] });
  expect(await detectText({ bytes: png }, { fetch: answer(200, { responses: [{ textAnnotations: [] }] }) })).toEqual({ text: "", words: [] });
  /* The full text can come from fullTextAnnotation when the first annotation has none. */
  expect((await detectText({ bytes: png }, { fetch: answer(200, { responses: [{ textAnnotations: [{ locale: "en" }], fullTextAnnotation: { text: "FROM FULL" } }] }) })).text).toBe("FROM FULL");
});

test("a clear refusal (4xx but not 408) and an error inside a 200 are before any work; 408, 5xx, no answer and an unreadable reply are not; nothing carries the key", async () => {
  for (const status of [400, 403, 404, 429]) await expect(detectText({ bytes: png }, { fetch: answer(status, { error: { message: "no" } }) }), String(status)).rejects.toMatchObject({ status, rejectedBeforeWork: true });
  for (const status of [408, 500, 503]) await expect(detectText({ bytes: png }, { fetch: answer(status, "") }), String(status)).rejects.toMatchObject({ status, rejectedBeforeWork: false });
  await expect(detectText({ bytes: png }, { fetch: answer(200, { responses: [{ error: { code: 3, message: "Bad image data." } }] }) })).rejects.toMatchObject({ rejectedBeforeWork: true, message: expect.stringContaining("Bad image data") });
  const dropped = (async () => { throw new TypeError("fetch failed"); }) as never;
  await expect(detectText({ bytes: png }, { fetch: dropped })).rejects.toMatchObject({ message: "Google did not answer.", rejectedBeforeWork: false });
  for (const body of ["not json", {}, { responses: [] }, { responses: ["x"] }, { responses: [{ textAnnotations: [{ locale: "en" }] }] }]) await expect(detectText({ bytes: png }, { fetch: answer(200, body) }), JSON.stringify(body)).rejects.toThrow(VisionError);
  const long = await detectText({ bytes: png }, { fetch: answer(400, { error: { message: "x".repeat(900) } }) }).catch((e: VisionError) => e);
  expect((long as VisionError).message.length).toBeLessThan(260);
  expect((long as VisionError).message).not.toContain(KEY);
});

test("an empty or oversized picture and a missing key never reach the vendor", async () => {
  const seen: Seen[] = [];
  const f = answer(200, { responses: [{}] }, seen);
  await expect(detectText({ bytes: Buffer.alloc(0) }, { fetch: f })).rejects.toMatchObject({ rejectedBeforeWork: true });
  await expect(detectText({ bytes: Buffer.alloc(VISION_IMAGE_LIMIT_BYTES + 1) }, { fetch: f })).rejects.toMatchObject({ rejectedBeforeWork: true });
  delete process.env.GOOGLE_VISION_API_KEY;
  await expect(detectText({ bytes: png }, { fetch: f })).rejects.toMatchObject({ message: expect.stringContaining("GOOGLE_VISION_API_KEY is needed"), rejectedBeforeWork: true });
  expect(visionConfigured()).toBe(false);
  expect(seen).toHaveLength(0);
});

test("the fixture (ENGINE_MOCK=1): no request leaves the process; MOCKTEXT: pictures show their text, any other shows none, [[mock-refuse]] is a refusal", async () => {
  process.env.ENGINE_MOCK = "1";
  delete process.env.GOOGLE_VISION_API_KEY;
  expect(visionConfigured()).toBe(true);
  const never = (async () => { throw new Error("no request may be made in a mock"); }) as never;
  expect(await detectText({ bytes: Buffer.from("MOCKTEXT:ACME COLA\n330 ml") }, { fetch: never })).toEqual({ text: "ACME COLA\n330 ml", words: [{ text: "ACME", box: [0, 0, 9, 8] }, { text: "COLA", box: [10, 0, 19, 8] }, { text: "330", box: [20, 0, 29, 8] }, { text: "ml", box: [30, 0, 39, 8] }] });
  expect(await detectText({ bytes: Buffer.from("just a picture") }, { fetch: never })).toEqual({ text: "", words: [] });
  await expect(detectText({ bytes: Buffer.from("MOCKTEXT:[[mock-refuse]]") }, { fetch: never })).rejects.toMatchObject({ rejectedBeforeWork: true, status: 400 });
  /* The size rule still applies to a fixture. */
  await expect(detectText({ bytes: Buffer.alloc(0) }, { fetch: never })).rejects.toThrow(VisionError);
});
