import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * AWS Elemental MediaConvert, Mumbai (lib/mediaConvert.ts). File-only: the adapter, its fixture and this spec; nothing is wired to a door, a tool, the cron or a price path.
 * Mocked: every request goes to a fake fetch this file hands the adapter (its `deps` seam), or to the in-process fixture under ENGINE_MOCK=1; no request leaves this process and no
 * provider is paid. No database. Neutral sample names; the keys, role and bucket below are made up.
 */
const ENV = {
  MEDIACONVERT_ACCESS_KEY_ID: "AKIATESTONLYNOTREAL", MEDIACONVERT_SECRET_ACCESS_KEY: "test-secret-not-real", MEDIACONVERT_REGION: "ap-south-1",
  MEDIACONVERT_ROLE_ARN: "arn:aws:iam::123456789012:role/sample-mediaconvert", MEDIACONVERT_BUCKET: "sample-reframe-bucket", MEDIACONVERT_ENDPOINT: "https://abcd1234.mediaconvert.ap-south-1.amazonaws.com",
} as Record<string, string | undefined>;
const NOW = new Date("2026-10-16T08:00:00Z");
const realMock = process.env.ENGINE_MOCK;
test.beforeEach(() => { delete process.env.ENGINE_MOCK; });
test.afterEach(() => { if (realMock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = realMock; });

type Seen = { url: string; method: string; headers: Record<string, string>; body: string; redirect?: string };
/** A fake fetch that records every request and answers from a queue (or a function). */
function fake(...answers: (Response | ((seen: Seen) => Response))[]) {
  const seen: Seen[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    const entry: Seen = { url: String(url), method: String(init?.method), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("latin1") : typeof init?.body === "string" ? init.body : "", redirect: init?.redirect };
    seen.push(entry);
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    return typeof next === "function" ? next(entry) : next.clone();
  }) as typeof fetch;
  return { f, seen };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const deps = (f: typeof fetch, env = ENV) => ({ fetch: f, now: () => NOW, env });
const INPUT = { workspaceId: "ws_sample", jobId: "job_sample_1", width: 1080, height: 1920 };

test("the price: the Basic-tier first-tier Mumbai rates (verified 16 Oct 2026), by resolution class and frame-rate band; per second rounded up to fractional minutes, at least 10 seconds, to the micro-dollar rounded up", async () => {
  const mc = await import("../../lib/mediaConvert");
  expect(mc.MEDIACONVERT_RATES.tier).toBe("basic");
  expect(mc.MEDIACONVERT_RATES.usdPerOutputMinute).toEqual({
    sd: { le30: 0.0075, le60: 0.0094, gt60: 0.0113 }, hd: { le30: 0.015, le60: 0.0188, gt60: 0.0225 }, uhd: { le30: 0.03, le60: 0.0375, gt60: 0.045 },
  });
  expect(mc.MEDIACONVERT_RATES.minimumBilledSeconds).toBe(10);
  expect(readFileSync("lib/mediaConvert.ts", "utf8")).toMatch(/Verified against AWS's price list API for ap-south-1, 16 Oct 2026; confirm against the first invoice[\s\S]{0,1400}export const MEDIACONVERT_RATES/);
  const hd = { width: 1080, height: 1920, fps: 30 };
  /* A portrait 1080x1920 is HD (the same pixels as 1920x1080). */
  expect(mc.mediaConvertBand(hd)).toEqual({ size: "hd", rate: "le30" });
  expect(mc.mediaConvertBand({ width: 720, height: 576, fps: 25 })).toEqual({ size: "sd", rate: "le30" });
  expect(mc.mediaConvertBand({ width: 722, height: 576, fps: 25 })).toEqual({ size: "hd", rate: "le30" });
  expect(mc.mediaConvertBand({ width: 3840, height: 2160, fps: 60 })).toEqual({ size: "uhd", rate: "le60" });
  expect(mc.mediaConvertBand({ ...hd, fps: 30.01 }).rate).toBe("le60");
  expect(mc.mediaConvertBand({ ...hd, fps: 60.5 }).rate).toBe("gt60");
  /* 5 s is billed as the 10 s minimum; 61 s is 61 seconds as fractional minutes. */
  expect(mc.mediaConvertUsd(5, hd)).toBeCloseTo((10 / 60) * 0.015, 9);
  expect(mc.mediaConvertUsd(10, hd)).toBeCloseTo((10 / 60) * 0.015, 9);
  expect(mc.mediaConvertUsd(61, hd)).toBeCloseTo((61 / 60) * 0.015, 9);
  expect(mc.mediaConvertUsd(60.2, hd)).toBeCloseTo((61 / 60) * 0.015, 9);
  expect(mc.mediaConvertUsd(60, { ...hd, fps: 60 })).toBeCloseTo(0.0188, 9);
  expect(mc.mediaConvertUsd(60, { width: 3840, height: 2160, fps: 24 })).toBeCloseTo(0.03, 9);
  expect(mc.mediaConvertUsd(60, { width: 3840, height: 2160, fps: 120 })).toBeCloseTo(0.045, 9);
  expect(mc.mediaConvertUsd(60, { width: 640, height: 480, fps: 25 })).toBeCloseTo(0.0075, 9);
  /* Never under, and never the cheaper later volume tiers ($0.0053 and below). */
  for (const seconds of [3.3, 10, 61, 123.4]) expect(mc.mediaConvertUsd(seconds, hd)).toBeGreaterThanOrEqual((Math.max(10, seconds) / 60) * 0.015 - 1e-12);
  expect(JSON.stringify(mc.MEDIACONVERT_RATES)).not.toMatch(/0\.0053|0\.0038|0\.0019/);
  for (const bad of [0, -1, Number.NaN]) expect(() => mc.mediaConvertUsd(bad, hd)).toThrow(/length/);
  for (const bad of [{ ...hd, fps: 0 }, { ...hd, width: Number.NaN }]) expect(() => mc.mediaConvertUsd(10, bad)).toThrow(/size and frame rate/);
});

test("the settings: every name is the plan's, none can be an R2 or S3 key, Mumbai only, and each address is checked before any request", async () => {
  const mc = await import("../../lib/mediaConvert");
  const source = readFileSync("lib/mediaConvert.ts", "utf8");
  const names = [...new Set([...source.matchAll(/env\.(MEDIACONVERT_[A-Z_]+)/g)].map((m) => m[1]))].sort();
  expect(names).toEqual(["MEDIACONVERT_ACCESS_KEY_ID", "MEDIACONVERT_BUCKET", "MEDIACONVERT_ENDPOINT", "MEDIACONVERT_QUEUE_ARN", "MEDIACONVERT_REGION", "MEDIACONVERT_ROLE_ARN", "MEDIACONVERT_SECRET_ACCESS_KEY"]);
  expect(mc.MEDIACONVERT_SWITCH).toBe("MEDIACONVERT_ENABLED");
  /* Nothing else of the environment is read: no AWS_*, R2_*, S3_*, STORAGE_*, BLOB_*, REKOGNITION_*. */
  expect(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/process\.env\.(?!MEDIACONVERT)|(?:AWS|R2|S3|STORAGE|BLOB|REKOGNITION)_[A-Z_]+/);
  const { f, seen } = fake(json(200, {}));
  const call = (env: Record<string, string | undefined>) => mc.getReframeJob("job_1", deps(f, env)).then(() => null, (e) => e);
  expect(mc.mediaConvertConfigured(ENV)).toBe(true);
  expect(mc.mediaConvertConfigured({})).toBe(false);
  const bad: [string, Record<string, string | undefined>][] = [
    ["no key", { ...ENV, MEDIACONVERT_ACCESS_KEY_ID: undefined }], ["no secret", { ...ENV, MEDIACONVERT_SECRET_ACCESS_KEY: undefined }],
    ["another region", { ...ENV, MEDIACONVERT_REGION: "us-east-1" }], ["no role", { ...ENV, MEDIACONVERT_ROLE_ARN: undefined }], ["a user, not a role", { ...ENV, MEDIACONVERT_ROLE_ARN: "arn:aws:iam::123456789012:user/x" }],
    ["no bucket", { ...ENV, MEDIACONVERT_BUCKET: undefined }], ["a bucket with dots", { ...ENV, MEDIACONVERT_BUCKET: "a.b.c" }], ["an uppercase bucket", { ...ENV, MEDIACONVERT_BUCKET: "Sample-Bucket" }], ["a bucket with a path", { ...ENV, MEDIACONVERT_BUCKET: "bucket/x" }],
    ["http endpoint", { ...ENV, MEDIACONVERT_ENDPOINT: "http://abcd1234.mediaconvert.ap-south-1.amazonaws.com" }], ["another host", { ...ENV, MEDIACONVERT_ENDPOINT: "https://evil.example.com" }],
    ["another region's endpoint", { ...ENV, MEDIACONVERT_ENDPOINT: "https://abcd1234.mediaconvert.us-east-1.amazonaws.com" }], ["a lookalike host", { ...ENV, MEDIACONVERT_ENDPOINT: "https://abcd1234.mediaconvert.ap-south-1.amazonaws.com.evil.com" }],
    ["an endpoint with a port", { ...ENV, MEDIACONVERT_ENDPOINT: "https://abcd1234.mediaconvert.ap-south-1.amazonaws.com:8443" }], ["an endpoint with credentials", { ...ENV, MEDIACONVERT_ENDPOINT: "https://u:p@abcd1234.mediaconvert.ap-south-1.amazonaws.com" }],
    ["an endpoint with a path", { ...ENV, MEDIACONVERT_ENDPOINT: "https://abcd1234.mediaconvert.ap-south-1.amazonaws.com/x" }], ["a queue elsewhere", { ...ENV, MEDIACONVERT_QUEUE_ARN: "arn:aws:mediaconvert:us-east-1:123456789012:queues/Default" }],
  ];
  for (const [label, env] of bad) {
    const error = await call(env);
    expect(error, label).toBeInstanceOf(mc.MediaConvertError);
    expect(error.kind, label).toBe("config");
  }
  expect(seen).toEqual([]);
  expect(mc.mediaConvertEndpoint("https://abcd1234.mediaconvert.ap-south-1.amazonaws.com")?.origin).toBe("https://abcd1234.mediaconvert.ap-south-1.amazonaws.com");
  expect(mc.mediaConvertEndpoint("https://abcd1234.mediaconvert.ap-south-1.amazonaws.com/")?.origin).toBe("https://abcd1234.mediaconvert.ap-south-1.amazonaws.com");
});

test("object keys have one shape, `<workspace>/<job>/...`, and nothing free-form reaches the bucket", async () => {
  const mc = await import("../../lib/mediaConvert");
  expect(mc.mediaConvertInputKey("ws_sample", "job_1")).toBe("ws_sample/job_1/input.mp4");
  expect(mc.mediaConvertOutputKey("ws_sample/job_1/input.mp4")).toBe("ws_sample/job_1/out/input_reframed.mp4");
  for (const [ws, job] of [["", "j"], ["w", ""], ["../x", "j"], ["w/x", "j"], ["w", "j/../k"], ["w ", "j"], ["w", "j.mp4"], ["a".repeat(65), "j"]]) expect(() => mc.mediaConvertInputKey(ws, job), `${ws}|${job}`).toThrow(mc.MediaConvertError);
  for (const key of ["ws/job/other.mp4", "ws/job/../x/input.mp4", "ws/input.mp4", "/ws/job/input.mp4", "ws/job/out/input_reframed.mp4"]) expect(() => mc.mediaConvertOutputKey(key), key).toThrow(mc.MediaConvertError);
  /* The bucket is reached only through a checked key, before any request. */
  const { f, seen } = fake(json(200, {}));
  for (const key of ["../x", "ws/job/input.mp4/extra", "ws//input.mp4", "ws/job/input.mp3"]) {
    await expect(mc.putInput(key, Buffer.from("x"), deps(f)), key).rejects.toThrow(mc.MediaConvertError);
    await expect(mc.deleteObject(key, deps(f)), key).rejects.toThrow(mc.MediaConvertError);
  }
  await expect(mc.putInput("ws_sample/job_1/out/input_reframed.mp4", Buffer.from("x"), deps(f))).rejects.toThrow(/input key/);
  await expect(mc.getOutput("ws_sample/job_1/input.mp4", deps(f))).rejects.toThrow(/output key/);
  await expect(mc.putInput("ws_sample/job_1/input.mp4", Buffer.alloc(0), deps(f))).rejects.toThrow(/empty/);
  expect(seen).toEqual([]);
});

test("the job body: one H.264 + AAC MP4 at the asked size, the input and destination under the workspace's own prefix, the job id as its idempotency token, never H.265", async () => {
  const mc = await import("../../lib/mediaConvert");
  const cfg = { roleArn: ENV.MEDIACONVERT_ROLE_ARN!, bucket: ENV.MEDIACONVERT_BUCKET!, queueArn: null };
  const body = JSON.parse(JSON.stringify(mc.reframeJobBody(INPUT, cfg)));
  expect(body).toMatchObject({ Role: ENV.MEDIACONVERT_ROLE_ARN, ClientRequestToken: "job_sample_1", UserMetadata: { job: "job_sample_1" } });
  expect(body.Queue).toBeUndefined();
  const input = body.Settings.Inputs[0];
  expect(input.FileInput).toBe("s3://sample-reframe-bucket/ws_sample/job_sample_1/input.mp4");
  const group = body.Settings.OutputGroups[0];
  expect(group.OutputGroupSettings.FileGroupSettings.Destination).toBe("s3://sample-reframe-bucket/ws_sample/job_sample_1/out/");
  const out = group.Outputs[0];
  expect(out).toMatchObject({ NameModifier: "_reframed", ContainerSettings: { Container: "MP4" } });
  expect(out.VideoDescription).toMatchObject({ Width: 1080, Height: 1920, CodecSettings: { Codec: "H_264" } });
  expect(out.VideoDescription.Crop).toBeUndefined();
  expect(out.AudioDescriptions[0].CodecSettings.Codec).toBe("AAC");
  /* The destination plus the modifier is where the output key says the result is. */
  expect(mc.mediaConvertOutputKey("ws_sample/job_sample_1/input.mp4")).toBe("ws_sample/job_sample_1/out/input_reframed.mp4");
  /* H.265 stays off until the owner's lawyer answers. */
  expect(JSON.stringify(body)).not.toMatch(/H_265|HEVC|H265/i);
  expect(readFileSync("lib/mediaConvert.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/H_265|HEVC/i);
  /* A crop and a queue, when given. */
  const cropped = JSON.parse(JSON.stringify(mc.reframeJobBody({ ...INPUT, crop: { x: 100, y: 0, width: 1080, height: 1920 } }, { ...cfg, queueArn: "arn:aws:mediaconvert:ap-south-1:123456789012:queues/Default" })));
  expect(cropped.Queue).toBe("arn:aws:mediaconvert:ap-south-1:123456789012:queues/Default");
  expect(cropped.Settings.OutputGroups[0].Outputs[0].VideoDescription.Crop).toEqual({ X: 100, Y: 0, Width: 1080, Height: 1920 });
  for (const bad of [{ width: 1081 }, { height: 100 }, { width: 5000 }, { width: 1080.5 }, { crop: { x: 1, y: 0, width: 100, height: 100 } }, { crop: { x: 0, y: 0, width: 101, height: 100 } }, { crop: { x: -2, y: 0, width: 100, height: 100 } }, { workspaceId: "../x" }])
    expect(() => mc.reframeJobBody({ ...INPUT, ...bad }, cfg), JSON.stringify(bad)).toThrow(mc.MediaConvertError);
});

test("the requests: signed for the right service in Mumbai, to the account's endpoint (set, or discovered once), the bucket by its own virtual-hosted address, and no redirect is ever followed", async () => {
  const mc = await import("../../lib/mediaConvert");
  /* A set endpoint: no lookup. */
  const a = fake(json(200, { Job: { Id: "1700000000000-abc123" } }));
  const made = await mc.createReframeJob(INPUT, deps(a.f));
  expect(made).toEqual({ id: "1700000000000-abc123", inputKey: "ws_sample/job_sample_1/input.mp4", outputKey: "ws_sample/job_sample_1/out/input_reframed.mp4" });
  expect(a.seen).toHaveLength(1);
  expect(a.seen[0]).toMatchObject({ url: "https://abcd1234.mediaconvert.ap-south-1.amazonaws.com/2017-08-29/jobs", method: "POST", redirect: "error" });
  expect(a.seen[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATESTONLYNOTREAL\/20261016\/ap-south-1\/mediaconvert\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
  expect(a.seen[0].headers["x-amz-date"]).toBe("20261016T080000Z");
  expect(a.seen[0].headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(a.seen[0].body).digest("hex"));
  expect(JSON.parse(a.seen[0].body)).toMatchObject({ ClientRequestToken: "job_sample_1", Role: ENV.MEDIACONVERT_ROLE_ARN });
  /* The secret never travels. */
  expect(JSON.stringify(a.seen)).not.toContain("test-secret-not-real");
  /* No endpoint set: discovered once (DescribeEndpoints on the regional address), then remembered. */
  const env = { ...ENV, MEDIACONVERT_ENDPOINT: undefined, MEDIACONVERT_ACCESS_KEY_ID: "AKIADISCOVERONLY" };
  const b = fake((s) => (s.url.endsWith("/endpoints") ? json(200, { Endpoints: [{ Url: "https://zz99yy88.mediaconvert.ap-south-1.amazonaws.com" }] }) : json(200, { Job: { Id: "job-b-1" } })));
  await mc.createReframeJob(INPUT, deps(b.f, env));
  await mc.createReframeJob({ ...INPUT, jobId: "job_sample_2" }, deps(b.f, env));
  expect(b.seen.map((s) => s.url)).toEqual([
    "https://mediaconvert.ap-south-1.amazonaws.com/2017-08-29/endpoints", "https://zz99yy88.mediaconvert.ap-south-1.amazonaws.com/2017-08-29/jobs", "https://zz99yy88.mediaconvert.ap-south-1.amazonaws.com/2017-08-29/jobs",
  ]);
  expect(b.seen[0].headers.authorization).toContain("/ap-south-1/mediaconvert/aws4_request");
  /* A lookup that names a host that is not this account's MediaConvert address is refused: the job (and the role) are never sent there. */
  for (const url of ["https://evil.example.com", "http://zz99yy88.mediaconvert.ap-south-1.amazonaws.com", "https://zz99yy88.mediaconvert.us-east-1.amazonaws.com", "https://x.mediaconvert.ap-south-1.amazonaws.com.evil.com"]) {
    const c = fake(json(200, { Endpoints: [{ Url: url }] }));
    const error = await mc.createReframeJob(INPUT, deps(c.f, { ...env, MEDIACONVERT_ACCESS_KEY_ID: `AKIAFORBAD${url.length}` })).then(() => null, (e) => e);
    expect(error, url).toBeInstanceOf(mc.MediaConvertError);
    expect(c.seen.every((s) => s.url.startsWith("https://mediaconvert.ap-south-1.amazonaws.com/"))).toBe(true);
  }
  /* The bucket: virtual-hosted, Mumbai, signed for s3 with the bytes' own hash; the clip is read back capped. */
  const bytes = Buffer.from("sample-clip-bytes");
  const s3 = fake(new Response(null, { status: 200 }));
  await mc.putInput("ws_sample/job_sample_1/input.mp4", bytes, deps(s3.f));
  expect(s3.seen[0]).toMatchObject({ url: "https://sample-reframe-bucket.s3.ap-south-1.amazonaws.com/ws_sample/job_sample_1/input.mp4", method: "PUT", redirect: "error" });
  expect(s3.seen[0].headers.authorization).toContain("/ap-south-1/s3/aws4_request");
  expect(s3.seen[0].headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(s3.seen[0].headers["content-type"]).toBe("video/mp4");
  const got = fake(new Response("result-bytes", { status: 200 }));
  expect((await mc.getOutput("ws_sample/job_sample_1/out/input_reframed.mp4", deps(got.f))).toString()).toBe("result-bytes");
  expect(got.seen[0]).toMatchObject({ method: "GET", url: "https://sample-reframe-bucket.s3.ap-south-1.amazonaws.com/ws_sample/job_sample_1/out/input_reframed.mp4" });
  expect(await mc.getOutput("ws_sample/job_sample_1/out/input_reframed.mp4", deps(fake(new Response("", { status: 200 })).f)).then(() => null, (e) => e)).toBeInstanceOf(mc.MediaConvertError);
  expect(await mc.getOutput("ws_sample/job_sample_1/out/input_reframed.mp4", deps(fake(new Response("x", { status: 200, headers: { "content-length": String(mc.MEDIACONVERT_OUTPUT_LIMIT_BYTES + 1) } })).f)).then(() => null, (e) => e)).toMatchObject({ kind: "failed" });
  const del = fake(new Response(null, { status: 204 }));
  expect(await mc.deleteObject("ws_sample/job_sample_1/input.mp4", deps(del.f))).toBe(true);
  expect(del.seen[0]).toMatchObject({ method: "DELETE" });
  expect(await mc.deleteObject("ws_sample/job_sample_1/input.mp4", deps(fake(new Response(null, { status: 404 })).f))).toBe(true);
  /* No request follows a redirect: each is sent with redirect "error", and a redirecting server's answer is a failure. */
  const allSeen = [...a.seen, ...b.seen, ...s3.seen, ...got.seen, ...del.seen];
  expect(allSeen.every((s) => s.redirect === "error")).toBe(true);
  const redirecting = (async (_u: unknown, init?: RequestInit) => { if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect"); return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }); }) as typeof fetch;
  for (const go of [
    () => mc.createReframeJob(INPUT, deps(redirecting)), () => mc.getReframeJob("job_1", deps(redirecting)), () => mc.cancelReframeJob("job_1", deps(redirecting)),
    () => mc.putInput("ws_sample/job_sample_1/input.mp4", bytes, deps(redirecting)), () => mc.getOutput("ws_sample/job_sample_1/out/input_reframed.mp4", deps(redirecting)), () => mc.deleteObject("ws_sample/job_sample_1/input.mp4", deps(redirecting)),
  ]) expect(await go().then(() => null, (e) => e)).toBeInstanceOf(mc.MediaConvertError);
});

test("what AWS answers: a clear 4xx is a refusal before any job (a throttle too); a 5xx or a dropped connection may have made one; AWS's own words are never repeated", async () => {
  const mc = await import("../../lib/mediaConvert");
  const attempt = (answer: Response | (() => Response)) => mc.createReframeJob(INPUT, deps(typeof answer === "function" ? ((async () => answer()) as typeof fetch) : fake(answer).f)).then(() => null, (e) => e);
  for (const [status, early] of [[400, true], [403, true], [404, true], [409, true], [429, true], [408, false], [500, false], [503, false]] as const) {
    const error = await attempt(json(status, { message: `leaks ${ENV.MEDIACONVERT_ROLE_ARN} and ${ENV.MEDIACONVERT_BUCKET}` }, { "x-amzn-errortype": "TooManyRequestsException:http://internal.amazon.com/" }));
    expect(error, String(status)).toBeInstanceOf(mc.MediaConvertError);
    expect(error.rejectedBeforeWork, String(status)).toBe(early);
    expect(error.status).toBe(status);
    expect(error.message).not.toContain("arn:aws");
    expect(error.message).not.toContain("sample-reframe-bucket");
    expect(error.message).toMatch(/TooManyRequestsException/);
  }
  expect(await attempt(() => { throw new Error("socket hang up"); })).toMatchObject({ kind: "provider", rejectedBeforeWork: false });
  for (const bad of [{}, { Job: {} }, { Job: { Id: 5 } }, { Job: { Id: "../x" } }]) expect(await attempt(json(200, bad)), JSON.stringify(bad)).toMatchObject({ kind: "provider" });
});

test("a poll: every status word, the delivered length from AWS, an error as plain words, and a word we do not know is 'running', never a verdict", async () => {
  const mc = await import("../../lib/mediaConvert");
  const poll = (job: unknown, status = 200) => mc.getReframeJob("1700000000000-abc123", deps(fake(json(status, { Job: job })).f));
  expect(await poll({ Status: "SUBMITTED" })).toEqual({ status: "queued" });
  expect(await poll({ Status: "PROGRESSING" })).toEqual({ status: "running" });
  expect(await poll({ Status: "SomethingNew" })).toEqual({ status: "queued" });
  expect(await poll({ Status: "COMPLETE", OutputGroupDetails: [{ OutputDetails: [{ DurationInMs: 4200 }] }] })).toEqual({ status: "complete", outputSeconds: 4.2 });
  expect(await poll({ Status: "COMPLETE" })).toEqual({ status: "complete", outputSeconds: null });
  expect(await poll({ Status: "COMPLETE", OutputGroupDetails: [{ OutputDetails: [{ DurationInMs: -1 }] }] })).toEqual({ status: "complete", outputSeconds: null });
  const failed = await poll({ Status: "ERROR", ErrorCode: 1010, ErrorMessage: "The role arn:aws:iam::123456789012:role/sample-mediaconvert could not read s3://sample-reframe-bucket/ws_sample/x" });
  expect(failed).toEqual({ status: "failed", failure: "MediaConvert could not process this clip (error 1010)." });
  expect(JSON.stringify(failed)).not.toMatch(/arn:aws|sample-reframe/);
  expect(await poll({ Status: "CANCELED" })).toEqual({ status: "canceled", failure: "MediaConvert cancelled this job." });
  expect(await mc.getReframeJob("j1", deps(fake(json(404, { message: "no" })).f)).then(() => null, (e) => e)).toMatchObject({ kind: "refused", status: 404 });
  expect(await mc.getReframeJob("../x", deps(fake(json(200, {})).f)).then(() => null, (e) => e)).toBeInstanceOf(mc.MediaConvertError);
  /* A cancel: gone is gone (a 404 too); any other refusal is raised. */
  expect(await mc.cancelReframeJob("j1", deps(fake(json(202, {})).f))).toBe(true);
  expect(await mc.cancelReframeJob("j1", deps(fake(json(404, {})).f))).toBe(true);
  expect(await mc.cancelReframeJob("j1", deps(fake(json(409, {})).f)).then(() => null, (e) => e)).toBeInstanceOf(mc.MediaConvertError);
});

test("the fixture end to end (ENGINE_MOCK): copy in, create, poll, read back, delete, in process, with the network forbidden; a clip that begins [[mock-fail]] fails", async () => {
  process.env.ENGINE_MOCK = "1";
  const mc = await import("../../lib/mediaConvert");
  const original = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no network in this test"); }) as never;
  try {
    expect(mc.mediaConvertConfigured({})).toBe(true);
    const job = await mc.createReframeJob({ ...INPUT, jobId: "job_fixture_ok" });
    await mc.putInput(job.inputKey, Buffer.from("a clip"));
    expect(await mc.getReframeJob(job.id)).toEqual({ status: "running" });
    expect(await mc.getReframeJob(job.id)).toEqual({ status: "complete", outputSeconds: 5 });
    expect((await mc.getOutput(job.outputKey)).toString()).toBe("mock-mediaconvert-output");
    expect(await mc.deleteObject(job.outputKey)).toBe(true);
    expect(await mc.deleteObject(job.inputKey)).toBe(true);
    await expect(mc.getOutput(job.outputKey)).rejects.toMatchObject({ kind: "refused" });
    const bad = await mc.createReframeJob({ ...INPUT, jobId: "job_fixture_bad" });
    await mc.putInput(bad.inputKey, Buffer.from("[[mock-fail]] a clip"));
    await mc.getReframeJob(bad.id);
    expect(await mc.getReframeJob(bad.id)).toMatchObject({ status: "failed", failure: "MediaConvert could not process this clip." });
    expect(await mc.cancelReframeJob(bad.id)).toBe(true);
    await expect(mc.getReframeJob("never_made")).rejects.toMatchObject({ kind: "refused", status: 404 });
    /* The fixture checks its inputs like the real thing. */
    await expect(mc.createReframeJob({ ...INPUT, width: 1081 })).rejects.toThrow(mc.MediaConvertError);
    expect(outbound).toBe(0);
  } finally { globalThis.fetch = original; }
});

test("structure: a file-only adapter that touches no shared module, reads only its own names, signs with the storage signer and no SDK, and logs nothing", () => {
  const source = readFileSync("lib/mediaConvert.ts", "utf8");
  const imports = [...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort();
  expect(imports).toEqual(["./mock", "./recovery", "./storage/r2"]);
  expect(source).not.toMatch(/@aws-sdk|aws-sdk|console\.(log|error|info|warn)/);
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  expect(code.match(/redirect: "error"/g)?.length).toBe(1);
  expect(source).toContain("(deps.fetch ?? recoveryFetch)(");
  expect(source.match(/\(deps\.fetch \?\? recoveryFetch\)\(/g)?.length).toBe(1);
  /* Nothing in the app reaches it yet. */
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = `${dir}/${f}`; return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
  const reachers = ["lib", "app", "components"].flatMap(walk).filter((f) => f !== "lib/mediaConvert.ts" && /mediaConvert["']/.test(readFileSync(f, "utf8")));
  expect(reachers).toEqual([]);
});
