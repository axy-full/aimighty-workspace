import { signRequest, sha256Hex, encodeKey, EMPTY_SHA256 } from "./storage/r2";
import { engineMock } from "./mock";
import { recoveryFetch } from "./recovery";

/**
 * AWS Elemental MediaConvert (Mumbai, `ap-south-1`): the reframe step that replaces Luma reframe (docs/plans/provider-adapters.md § 9 and M1). **File-only: nothing here is wired to a
 * door, a tool, the cron or a price path yet**; this is the adapter, its fixture and its spec. It is signed with the SigV4 header signing the storage code already has
 * (lib/storage/r2.ts `signRequest`), with no AWS SDK, so nothing an SDK reads by itself (an `AWS_*` setting, a shared config file, an instance role) can ever be consulted, and the
 * R2 keys can never be used here: this file reads only the `MEDIACONVERT_*` names below.
 *
 * Settings (names only; set in the deployment): MEDIACONVERT_ACCESS_KEY_ID and MEDIACONVERT_SECRET_ACCESS_KEY (its OWN key pair, not Rekognition's, which cannot create a job),
 * MEDIACONVERT_REGION (unset, or exactly ap-south-1), MEDIACONVERT_ROLE_ARN (the IAM role MediaConvert assumes to read and write the bucket), MEDIACONVERT_BUCKET (an S3 bucket in
 * ap-south-1, private, with an expiry rule: owner action), MEDIACONVERT_ENDPOINT (optional: the account's own address; unset means it is discovered once with DescribeEndpoints),
 * MEDIACONVERT_QUEUE_ARN (optional: only if the default queue is not used) and MEDIACONVERT_ENABLED (the kill switch, lib/engineGate.ts). None starts with AWS_, R2_, S3_, STORAGE_ or BLOB_.
 * Under ENGINE_MOCK=1 nothing is called: an in-process fixture answers (below).
 *
 * What is called: `POST /2017-08-29/endpoints` (DescribeEndpoints, on `mediaconvert.ap-south-1.amazonaws.com`), `POST /2017-08-29/jobs` (CreateJob), `GET /2017-08-29/jobs/{id}`
 * (GetJob), `DELETE /2017-08-29/jobs/{id}` (CancelJob), and S3 `PUT`, `GET` and `DELETE` on one object key in the bucket (virtual-hosted style, `service: s3`). **Field names
 * follow AWS's public MediaConvert API as the plan records it and are TO CONFIRM against AWS's reference on the first real use**; every reply is read defensively.
 *
 * Privacy and tenancy. Every object key is `<workspace id>/<job id>/...` (checked, one fixed shape), so no key can reach another workspace's files and a path is never built from free
 * text. The caller copies the clip in, creates the job, polls, copies the result back under the workspace's own R2 prefix and then deletes both AWS objects. A job's metadata holds
 * its own id only. H.265 is never requested: the codec is H.264 (the owner's lawyer has not answered). No request follows a redirect (`redirect: "error"`): the signature is in a
 * header and undici forwards custom headers across an origin. Every address this file calls is checked against the AWS hosts it expects before a request is made.
 *
 * Idempotency. CreateJob carries a `ClientRequestToken` (the job's own id), which AWS uses to return the same job for a repeated request, so a lost reply can be retried without a
 * second job. The caller still holds the "never sent twice" rule it holds for every other engine; the token is a second wall, not a licence.
 */
export const MEDIACONVERT_SWITCH = "MEDIACONVERT_ENABLED";
/** The one region the clip is sent to. */
export const MEDIACONVERT_REGION_ONLY = "ap-south-1";
export const MEDIACONVERT_API_VERSION = "2017-08-29";
export const MEDIACONVERT_INPUT_LIMIT_BYTES = 512 * 1024 * 1024;
export const MEDIACONVERT_OUTPUT_LIMIT_BYTES = 512 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 300_000;
/** The output file's name modifier: MediaConvert names an output `<input name><modifier>.<container>`. */
const NAME_MODIFIER = "_reframed";

/** A failure of the adapter. `rejectedBeforeWork`: AWS answered with a clear 4xx before it created anything (a refusal, a throttle), so the reservation can come back whole. */
export class MediaConvertError extends Error {
  constructor(message: string, readonly kind: "config" | "refused" | "provider" | "failed", readonly status: number | null = null, readonly rejectedBeforeWork = false) { super(message); this.name = "MediaConvertError"; }
}

/**
 * MediaConvert's price, in the vendor's own unit: dollars per OUTPUT minute, Mumbai (`ap-south-1`), **Basic tier, AVC/H.264 single pass** (the one job shape this file builds), at the
 * FIRST volume tier (never the cheaper later tiers: a quote is never under). **Verified against AWS's price list API for ap-south-1, 16 Oct 2026; confirm against the first invoice.**
 * The rate depends on the output's resolution class and frame-rate band. Billing is per second, converted to fractional minutes, with a 10-second minimum per output
 * (aws.amazon.com/mediaconvert/pricing). The resolution-class boundaries below are AWS's classes read by pixel count and are TO CONFIRM against its definition: SD is up to 720x576, HD
 * up to 1920x1080 (a 1080x1920 portrait is HD: the same pixels), anything larger is 4K. Server-only like every rate here.
 */
export const MEDIACONVERT_RATES = {
  tier: "basic",
  usdPerOutputMinute: {
    sd: { le30: 0.0075, le60: 0.0094, gt60: 0.0113 },
    hd: { le30: 0.015, le60: 0.0188, gt60: 0.0225 },
    uhd: { le30: 0.03, le60: 0.0375, gt60: 0.045 },
  },
  minimumBilledSeconds: 10,
  /** Pixel counts at which a class ends (inclusive). */
  sdMaxPixels: 720 * 576,
  hdMaxPixels: 1920 * 1080,
} as const;
export type MediaConvertRates = typeof MEDIACONVERT_RATES;

/** The resolution class and frame-rate band of an output, by AWS's classes. */
export function mediaConvertBand(shape: { width: number; height: number; fps: number }, rates: MediaConvertRates = MEDIACONVERT_RATES): { size: "sd" | "hd" | "uhd"; rate: "le30" | "le60" | "gt60" } {
  const { width, height, fps } = shape;
  if (![width, height, fps].every((n) => Number.isFinite(n) && n > 0)) throw new MediaConvertError("A job is priced from its size and frame rate.", "config");
  const pixels = width * height;
  return { size: pixels <= rates.sdMaxPixels ? "sd" : pixels <= rates.hdMaxPixels ? "hd" : "uhd", rate: fps <= 30 ? "le30" : fps <= 60 ? "le60" : "gt60" };
}

/** What one job costs for `outputSeconds` of output at this size and frame rate: whole seconds (rounded up, never under), at least the minimum, at the per-minute rate, to the micro-dollar rounded up. */
export function mediaConvertUsd(outputSeconds: number, shape: { width: number; height: number; fps: number }, rates: MediaConvertRates = MEDIACONVERT_RATES): number {
  if (!Number.isFinite(outputSeconds) || outputSeconds <= 0) throw new MediaConvertError("A job needs a length to be priced.", "config");
  const band = mediaConvertBand(shape, rates);
  const billed = Math.max(rates.minimumBilledSeconds, Math.ceil(outputSeconds - 1e-9));
  return Math.ceil((billed / 60) * rates.usdPerOutputMinute[band.size][band.rate] * 1e6 - 1e-6) / 1e6;
}

/* ── Settings ───────────────────────────────────────────────────────────────── */

export type MediaConvertSeams = { fetch?: typeof fetch; now?: () => Date; env?: Record<string, string | undefined> };
type Config = { accessKeyId: string; secretAccessKey: string; region: string; roleArn: string; bucket: string; endpoint: string | null; queueArn: string | null };

const ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const QUEUE_ARN = /^arn:aws:mediaconvert:ap-south-1:\d{12}:queues\/[\w-]{1,128}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** The account's own MediaConvert address: https, a label of letters and digits on mediaconvert.ap-south-1.amazonaws.com, no port, credentials, path or query. */
const ENDPOINT_HOST = /^[a-z0-9]{6,32}\.mediaconvert\.ap-south-1\.amazonaws\.com$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `raw` is exactly an https MediaConvert endpoint for this account's region and nothing more. */
export function mediaConvertEndpoint(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  return url.protocol === "https:" && !url.username && !url.password && !url.port && ENDPOINT_HOST.test(url.hostname) && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash ? url : null;
}

function configOf(env: Record<string, string | undefined>): Config {
  const accessKeyId = env.MEDIACONVERT_ACCESS_KEY_ID?.trim(), secretAccessKey = env.MEDIACONVERT_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) throw new MediaConvertError("This is not set up: MEDIACONVERT_ACCESS_KEY_ID and MEDIACONVERT_SECRET_ACCESS_KEY are needed.", "config");
  const region = (env.MEDIACONVERT_REGION ?? MEDIACONVERT_REGION_ONLY).trim() || MEDIACONVERT_REGION_ONLY;
  if (region !== MEDIACONVERT_REGION_ONLY) throw new MediaConvertError("MEDIACONVERT_REGION must be ap-south-1: clips are not sent anywhere else.", "config");
  const roleArn = env.MEDIACONVERT_ROLE_ARN?.trim() ?? "";
  if (!ROLE_ARN.test(roleArn)) throw new MediaConvertError("This is not set up: MEDIACONVERT_ROLE_ARN must be an IAM role ARN.", "config");
  const bucket = env.MEDIACONVERT_BUCKET?.trim() ?? "";
  if (!BUCKET.test(bucket)) throw new MediaConvertError("This is not set up: MEDIACONVERT_BUCKET must be an S3 bucket name (lowercase letters, digits and dashes).", "config");
  const rawEndpoint = env.MEDIACONVERT_ENDPOINT?.trim();
  const endpoint = rawEndpoint ? mediaConvertEndpoint(rawEndpoint)?.origin ?? null : null;
  if (rawEndpoint && !endpoint) throw new MediaConvertError("MEDIACONVERT_ENDPOINT must be an https address on mediaconvert.ap-south-1.amazonaws.com.", "config");
  const queueArn = env.MEDIACONVERT_QUEUE_ARN?.trim() || null;
  if (queueArn && !QUEUE_ARN.test(queueArn)) throw new MediaConvertError("MEDIACONVERT_QUEUE_ARN must be a MediaConvert queue ARN in ap-south-1.", "config");
  return { accessKeyId, secretAccessKey, region, roleArn, bucket, endpoint, queueArn };
}
/** Whether the adapter is set up (or is the fixture). Reads names only. */
export function mediaConvertConfigured(env: Record<string, string | undefined> = process.env): boolean {
  if (engineMock()) return true;
  try { configOf(env); return true; } catch { return false; }
}

/* ── Keys ───────────────────────────────────────────────────────────────────── */

/** The one shape of object key in the bucket: `<workspace id>/<job id>/input.mp4` going in, `<workspace id>/<job id>/out/input_reframed.mp4` coming out. */
const KEY = new RegExp(`^[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}/(?:input\\.mp4|out/input${NAME_MODIFIER}\\.mp4)$`);
export function mediaConvertInputKey(workspaceId: string, jobId: string): string {
  if (!ID.test(workspaceId) || !ID.test(jobId)) throw new MediaConvertError("A workspace and a job id are letters, digits, dashes and underscores.", "config");
  return `${workspaceId}/${jobId}/input.mp4`;
}
/** Where MediaConvert writes the result for an input key: the destination folder is `<workspace>/<job>/out/` and the name is the input's plus the modifier. */
export function mediaConvertOutputKey(inputKey: string): string {
  if (!KEY.test(inputKey) || !inputKey.endsWith("/input.mp4")) throw new MediaConvertError("That is not an input key of this bucket.", "config");
  return `${inputKey.slice(0, -"input.mp4".length)}out/input${NAME_MODIFIER}.mp4`;
}
const checkedKey = (key: string): string => { if (!KEY.test(key)) throw new MediaConvertError("That is not an object key of this bucket.", "config"); return key; };

/* ── The job ────────────────────────────────────────────────────────────────── */

export type CropRectangle = { x: number; y: number; width: number; height: number };
export type ReframeInput = { workspaceId: string; jobId: string; width: number; height: number; crop?: CropRectangle };
const even = (n: unknown, lo: number, hi: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi && n % 2 === 0;

/**
 * The CreateJob body for one reframe: the input in the bucket, one H.264 + AAC MP4 at `width` by `height`, optionally cropped first to `crop` (the caller chooses where; the plan's
 * "Smart Crop" placement is not a field this file can confirm, TO CONFIRM against AWS's reference). Pure, so a test reads exactly what is sent.
 */
export function reframeJobBody(input: ReframeInput, cfg: Pick<Config, "roleArn" | "bucket" | "queueArn">): Record<string, unknown> {
  if (!even(input.width, 128, 4096) || !even(input.height, 128, 4096)) throw new MediaConvertError("A reframe is an even width and height from 128 to 4096.", "config");
  const crop = input.crop;
  if (crop && ![crop.x, crop.y].every((n) => Number.isInteger(n) && n >= 0 && n % 2 === 0) || crop && !even(crop.width, 2, 8192) || crop && !even(crop.height, 2, 8192)) throw new MediaConvertError("A crop is an even position and size, inside the picture.", "config");
  const inputKey = mediaConvertInputKey(input.workspaceId, input.jobId);
  const destination = `s3://${cfg.bucket}/${inputKey.slice(0, -"input.mp4".length)}out/`;
  return {
    Role: cfg.roleArn,
    ...(cfg.queueArn ? { Queue: cfg.queueArn } : {}),
    ClientRequestToken: input.jobId,
    UserMetadata: { job: input.jobId },
    Settings: {
      Inputs: [{
        FileInput: `s3://${cfg.bucket}/${inputKey}`, TimecodeSource: "ZEROBASED",
        VideoSelector: {}, AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
      }],
      OutputGroups: [{
        Name: "File Group",
        OutputGroupSettings: { Type: "FILE_GROUP_SETTINGS", FileGroupSettings: { Destination: destination } },
        Outputs: [{
          NameModifier: NAME_MODIFIER,
          ContainerSettings: { Container: "MP4", Mp4Settings: {} },
          VideoDescription: {
            Width: input.width, Height: input.height, ScalingBehavior: "DEFAULT",
            ...(crop ? { Crop: { X: crop.x, Y: crop.y, Width: crop.width, Height: crop.height } } : {}),
            CodecSettings: { Codec: "H_264", H264Settings: { RateControlMode: "QVBR", QvbrSettings: { QvbrQualityLevel: 8 }, MaxBitrate: 8_000_000, SceneChangeDetect: "TRANSITION_DETECTION" } },
          },
          AudioDescriptions: [{ AudioSourceName: "Audio Selector 1", CodecSettings: { Codec: "AAC", AacSettings: { Bitrate: 96_000, CodingMode: "CODING_MODE_2_0", SampleRate: 48_000 } } }],
        }],
      }],
    },
  };
}

export type MediaConvertState =
  | { status: "queued" | "running" }
  | { status: "complete"; outputSeconds: number | null }
  | { status: "failed" | "canceled"; failure: string };

/* ── The fixture (ENGINE_MOCK=1) ────────────────────────────────────────────── */
const mockObjects = new Map<string, Buffer>();
const mockJobs = new Map<string, { polls: number; inputKey: string }>();
let mockSeq = 0;
const MOCK_OUTPUT = Buffer.from("mock-mediaconvert-output");
/** An input that begins "[[mock-fail]]" makes the job fail; any other completes on the second poll. */

/* ── Requests ───────────────────────────────────────────────────────────────── */

let discovered: { key: string; endpoint: string } | null = null;

async function send(method: "GET" | "POST" | "DELETE" | "PUT", url: URL, service: "mediaconvert" | "s3", body: Buffer | string | undefined, cfg: Config, deps: MediaConvertSeams, extra: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
  const signed = signRequest({
    method, url, payloadHash: body === undefined ? EMPTY_SHA256 : sha256Hex(body), credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }, region: cfg.region, service,
    date: (deps.now ?? (() => new Date()))(), headers: extra.headers,
  });
  try {
    return await (deps.fetch ?? recoveryFetch)(signed.url, { method, headers: signed.headers, ...(body !== undefined ? { body: typeof body === "string" ? body : new Uint8Array(body) } : {}), redirect: "error", signal: AbortSignal.timeout(extra.timeoutMs ?? TIMEOUT_MS) });
  } catch { throw new MediaConvertError("AWS did not answer.", "provider"); }
}
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}; } catch { return {}; }
}
/** AWS's error name from its header or body, short and plain; never AWS's free text (it can name a role or a bucket). */
const errorName = (res: Response, json: Record<string, unknown>): string => String(res.headers.get("x-amzn-errortype") ?? json.__type ?? json.code ?? "").split(/[#:]/)[0].replace(/[^A-Za-z]/g, "").slice(0, 60);
const refusal = (what: string, res: Response, json: Record<string, unknown>) => {
  const name = errorName(res, json);
  return new MediaConvertError(`AWS refused ${what}${name ? ` (${name})` : ""}.`, res.status >= 400 && res.status < 500 ? "refused" : "provider", res.status, res.status >= 400 && res.status < 500 && res.status !== 408);
};

/** The account's endpoint: the one set in MEDIACONVERT_ENDPOINT, else discovered once (DescribeEndpoints) and remembered for the process. Only an address of the expected shape is ever used. */
async function endpointOf(cfg: Config, deps: MediaConvertSeams): Promise<URL> {
  if (cfg.endpoint) return new URL(cfg.endpoint);
  const key = `${cfg.accessKeyId}:${cfg.region}`;
  if (discovered?.key === key) return new URL(discovered.endpoint);
  const res = await send("POST", new URL(`https://mediaconvert.${cfg.region}.amazonaws.com/${MEDIACONVERT_API_VERSION}/endpoints`), "mediaconvert", JSON.stringify({ MaxResults: 1 }), cfg, deps, { headers: { "content-type": "application/json" } });
  const json = await jsonOf(res);
  if (!res.ok) throw refusal("the endpoint lookup", res, json);
  const first = Array.isArray(json.Endpoints) ? (json.Endpoints[0] as { Url?: unknown } | undefined) : undefined;
  const url = mediaConvertEndpoint(first?.Url);
  if (!url) throw new MediaConvertError("AWS's reply named no MediaConvert address we can use.", "provider", res.status);
  discovered = { key, endpoint: url.origin };
  return url;
}

/** Starts one reframe job. The caller holds the reservation; this is the one paid request, and a repeat with the same job id returns the same job (the client request token). */
export async function createReframeJob(input: ReframeInput, deps: MediaConvertSeams = {}): Promise<{ id: string; inputKey: string; outputKey: string }> {
  const inputKey = mediaConvertInputKey(input.workspaceId, input.jobId);
  const outputKey = mediaConvertOutputKey(inputKey);
  if (engineMock()) {
    reframeJobBody(input, { roleArn: "arn:aws:iam::000000000000:role/mock", bucket: "mock-bucket", queueArn: null });
    const id = `mock_mc_${++mockSeq}`;
    mockJobs.set(id, { polls: 0, inputKey });
    return { id, inputKey, outputKey };
  }
  const cfg = configOf(deps.env ?? process.env);
  const body = JSON.stringify(reframeJobBody(input, cfg));
  const endpoint = await endpointOf(cfg, deps);
  const res = await send("POST", new URL(`${endpoint.origin}/${MEDIACONVERT_API_VERSION}/jobs`), "mediaconvert", body, cfg, deps, { headers: { "content-type": "application/json" } });
  const json = await jsonOf(res);
  if (!res.ok) throw refusal("the job", res, json);
  const job = json.Job && typeof json.Job === "object" ? (json.Job as { Id?: unknown }) : null;
  if (!job || typeof job.Id !== "string" || !ID.test(job.Id)) throw new MediaConvertError("AWS's reply named no job.", "provider", res.status);
  return { id: job.Id, inputKey, outputKey };
}

/** One poll. A status we do not know is "running", never a verdict from a word we do not know. */
export async function getReframeJob(jobId: string, deps: MediaConvertSeams = {}): Promise<MediaConvertState> {
  if (!ID.test(jobId)) throw new MediaConvertError("That is not a MediaConvert job id.", "config");
  if (engineMock()) {
    const job = mockJobs.get(jobId);
    if (!job) throw new MediaConvertError("MediaConvert has no such job.", "refused", 404, true);
    job.polls += 1;
    if (job.polls < 2) return { status: "running" };
    const input = mockObjects.get(job.inputKey);
    if (input?.subarray(0, 13).toString("utf8") === "[[mock-fail]]") return { status: "failed", failure: "MediaConvert could not process this clip." };
    mockObjects.set(mediaConvertOutputKey(job.inputKey), Buffer.from(MOCK_OUTPUT));
    return { status: "complete", outputSeconds: 5 };
  }
  const cfg = configOf(deps.env ?? process.env);
  const endpoint = await endpointOf(cfg, deps);
  const res = await send("GET", new URL(`${endpoint.origin}/${MEDIACONVERT_API_VERSION}/jobs/${jobId}`), "mediaconvert", undefined, cfg, deps);
  const json = await jsonOf(res);
  if (!res.ok) throw refusal("the status request", res, json);
  const job = (json.Job && typeof json.Job === "object" ? json.Job : {}) as { Status?: unknown; ErrorCode?: unknown; OutputGroupDetails?: unknown };
  const word = String(job.Status ?? "").toUpperCase();
  if (word === "COMPLETE") {
    const groups = Array.isArray(job.OutputGroupDetails) ? (job.OutputGroupDetails as { OutputDetails?: { DurationInMs?: unknown }[] }[]) : [];
    const ms = Number(groups[0]?.OutputDetails?.[0]?.DurationInMs);
    return { status: "complete", outputSeconds: Number.isFinite(ms) && ms > 0 ? ms / 1000 : null };
  }
  if (word === "ERROR") return { status: "failed", failure: `MediaConvert could not process this clip${job.ErrorCode != null ? ` (error ${String(job.ErrorCode).replace(/[^0-9A-Za-z]/g, "").slice(0, 12)})` : ""}.` };
  if (word === "CANCELED") return { status: "canceled", failure: "MediaConvert cancelled this job." };
  return { status: word === "PROGRESSING" ? "running" : "queued" };
}

/** Cancels a job that has not finished. True when it is cancelled or already gone. */
export async function cancelReframeJob(jobId: string, deps: MediaConvertSeams = {}): Promise<boolean> {
  if (!ID.test(jobId)) throw new MediaConvertError("That is not a MediaConvert job id.", "config");
  if (engineMock()) return mockJobs.delete(jobId) || true;
  const cfg = configOf(deps.env ?? process.env);
  const endpoint = await endpointOf(cfg, deps);
  const res = await send("DELETE", new URL(`${endpoint.origin}/${MEDIACONVERT_API_VERSION}/jobs/${jobId}`), "mediaconvert", undefined, cfg, deps);
  if (res.status === 404) return true;
  if (!res.ok) throw refusal("the cancel", res, await jsonOf(res));
  return true;
}

/* ── The bucket ─────────────────────────────────────────────────────────────── */

function objectUrl(cfg: Config, key: string): URL {
  return new URL(`https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${encodeKey(checkedKey(key))}`);
}
/** Copies the clip into the bucket under its one input key. */
export async function putInput(inputKey: string, bytes: Buffer, deps: MediaConvertSeams = {}): Promise<void> {
  checkedKey(inputKey);
  if (!inputKey.endsWith("/input.mp4")) throw new MediaConvertError("Only an input key can be written.", "config");
  if (!bytes.length || bytes.length > MEDIACONVERT_INPUT_LIMIT_BYTES) throw new MediaConvertError("The clip is empty or over 512 MB.", "config");
  if (engineMock()) { mockObjects.set(inputKey, Buffer.from(bytes)); return; }
  const cfg = configOf(deps.env ?? process.env);
  const res = await send("PUT", objectUrl(cfg, inputKey), "s3", bytes, cfg, deps, { headers: { "content-type": "video/mp4" }, timeoutMs: TRANSFER_TIMEOUT_MS });
  if (!res.ok) throw refusal("the upload", res, await jsonOf(res));
}
/** Reads the finished clip back, capped. Nothing is stored here. */
export async function getOutput(outputKey: string, deps: MediaConvertSeams = {}): Promise<Buffer> {
  checkedKey(outputKey);
  if (!outputKey.includes("/out/")) throw new MediaConvertError("Only an output key can be read.", "config");
  if (engineMock()) {
    const bytes = mockObjects.get(outputKey);
    if (!bytes) throw new MediaConvertError("The clip is not in the bucket.", "refused", 404, true);
    return Buffer.from(bytes);
  }
  const cfg = configOf(deps.env ?? process.env);
  const res = await send("GET", objectUrl(cfg, outputKey), "s3", undefined, cfg, deps, { timeoutMs: TRANSFER_TIMEOUT_MS });
  if (!res.ok) throw refusal("the download", res, await jsonOf(res));
  if (Number(res.headers.get("content-length") ?? 0) > MEDIACONVERT_OUTPUT_LIMIT_BYTES) throw new MediaConvertError("The clip is larger than Particl keeps.", "failed");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > MEDIACONVERT_OUTPUT_LIMIT_BYTES) throw new MediaConvertError("The clip came back empty or too large.", "failed");
  return bytes;
}
/** Deletes one of this job's two objects once the result is copied back. True when it is gone (or never was). */
export async function deleteObject(key: string, deps: MediaConvertSeams = {}): Promise<boolean> {
  checkedKey(key);
  if (engineMock()) { mockObjects.delete(key); return true; }
  const cfg = configOf(deps.env ?? process.env);
  const res = await send("DELETE", objectUrl(cfg, key), "s3", undefined, cfg, deps);
  if (res.ok || res.status === 404) return true;
  throw refusal("the delete", res, await jsonOf(res));
}
