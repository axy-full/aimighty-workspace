import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { withRecoveryActivity } from "../recovery";
import {
  ObjectExistsError,
  markNothingWritten,
  uncertainUnlessExists,
  type StorageBackend,
  type StoragePutOptions,
} from "./types";

/**
 * Cloudflare R2 through the AWS S3 SDK, loaded only when R2 is selected.
 * Signed reads expire after at most fifteen minutes.
 *
 * Path-style addressing (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>),
 * region "auto", service "s3". Conditional writes use If-None-Match: * and a
 * 412 is the ObjectExistsError the caller's verify path expects. Streams go
 * up as explicit multipart uploads in 8 MiB parts assembled from whatever
 * chunk size arrives, aborted on any failure so no orphan parts bill.
 */

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Defaults to https://<accountId>.r2.cloudflarestorage.com; path-style /<bucket>/<key>. */
  endpoint: string;
};

export type R2Dependencies = {
  /** Injected by tests; production uses the global fetch, bound late. */
  fetch?: typeof fetch;
  now?: () => Date;
};

export const R2_REGION = "auto";
export const R2_PART_SIZE = 8 * 1024 * 1024;
export const R2_MAX_PARTS = 10_000;
const DELETE_BATCH = 1000;
const PRESIGN_MAX_SECONDS = 15 * 60;
export const R2_MULTIPART_THRESHOLD = 100 * 1024 * 1024;
/** How long a failed multipart upload's AbortMultipartUpload may take. */
export const R2_ABORT_TIMEOUT_MS = 20_000;
const PRIVATE_CACHE_CONTROL = "private, max-age=31536000, immutable";

/* ── SigV4 ─────────────────────────────────────────────────────────────── */

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const sha256Hex = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 unreserved characters only; encodeURIComponent leaves !'()* alone and S3 does not. */
export const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Each segment encoded once; the slash between them is structural. */
export const encodeKey = (key: string): string => key.split("/").map(rfc3986).join("/");

export const canonicalQuery = (query: Record<string, string>): string =>
  Object.entries(query)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

const amzDate = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string };

export type SigV4Input = {
  method: string;
  /** Scheme, host and already-encoded path; the query is given separately so its encoding is canonical. */
  url: URL;
  query?: Record<string, string>;
  /** Headers to send and sign, besides host, x-amz-date and x-amz-content-sha256 which are added here. */
  headers?: Record<string, string>;
  payloadHash: string;
  credentials: SigV4Credentials;
  region: string;
  service?: string;
  date: Date;
};

export type SigV4Result = {
  url: string;
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
};

function scopeFor(date: Date, region: string, service: string) {
  const stamp = amzDate(date);
  return { stamp, day: stamp.slice(0, 8), scope: `${stamp.slice(0, 8)}/${region}/${service}/aws4_request` };
}

function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

function canonicalHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(""),
    signed: entries.map(([k]) => k).join(";"),
  };
}

/** Header authentication: Authorization plus the x-amz-* headers the request must carry. */
export function signRequest(input: SigV4Input): SigV4Result {
  const service = input.service ?? "s3";
  const { stamp, day, scope } = scopeFor(input.date, input.region, service);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: input.url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": stamp,
  };
  const { canonical, signed } = canonicalHeaders(headers);
  const query = canonicalQuery(input.query ?? {});
  const canonicalRequest = [input.method.toUpperCase(), input.url.pathname, query, canonical, signed, input.payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(input.credentials.secretAccessKey, day, input.region, service), stringToSign).toString("hex");
  const { host: _host, ...sendable } = headers;
  void _host;
  return {
    url: `${input.url.origin}${input.url.pathname}${query ? `?${query}` : ""}`,
    headers: {
      ...sendable,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

export type PresignInput = Omit<SigV4Input, "headers" | "payloadHash"> & { expiresSeconds: number };

/** Query-string authentication for a URL handed to someone without credentials. Only host is signed. */
export function presignRequest(input: PresignInput): SigV4Result {
  const service = input.service ?? "s3";
  const { stamp, day, scope } = scopeFor(input.date, input.region, service);
  const query: Record<string, string> = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalRequest = [input.method.toUpperCase(), input.url.pathname, canonicalQuery(query), `host:${input.url.host}\n`, "host", UNSIGNED_PAYLOAD].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(input.credentials.secretAccessKey, day, input.region, service), stringToSign).toString("hex");
  return {
    // The signature goes last, as AWS's own examples write it; the server sorts before verifying.
    url: `${input.url.origin}${input.url.pathname}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`,
    headers: {},
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** A non-success S3 response. Carries the status and S3 code, never a credential. */
export class R2RequestError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly operation: string, key?: string, cause?: unknown) {
    super(`R2 ${operation}${key ? ` ${key}` : ""} failed (${status}${code ? ` ${code}` : ""})`, { cause });
    this.name = "R2RequestError";
  }
}

const toBuffer = (chunk: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);


/* ── Backend ───────────────────────────────────────────────────────────── */

export function createR2Backend(config: R2Config, deps: R2Dependencies = {}): StorageBackend {
  const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  let clientPromise: Promise<import("@aws-sdk/client-s3").S3Client> | undefined;
  const sdk = () => import("@aws-sdk/client-s3");
  const client = () => clientPromise ??= sdk().then(({ S3Client }) => new S3Client({
    region: R2_REGION,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      async handle(request: { protocol: string; hostname: string; port?: number; path: string; method: string; headers: Record<string, string>; query?: Record<string, string | string[] | null | undefined>; body?: BodyInit }, options?: { abortSignal?: unknown }) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query ?? {})) {
          for (const item of Array.isArray(value) ? value : [value]) query.append(key, item ?? "");
        }
        const url = `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ""}${request.path}${query.size ? `?${query}` : ""}`;
        const timeout = AbortSignal.timeout(120_000);
        const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal as AbortSignal, timeout]) : timeout;
        // Node fetch rejects Expect: 100-continue. The SDK adds it for large
        // buffers, but SigV4 explicitly excludes this transport-only header.
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "expect"));
        const response = await fetchImpl(url, {
          method: request.method,
          headers: { ...headers, ...(request.method === "GET" ? { "accept-encoding": "identity" } : {}) },
          body: request.body,
          signal,
          redirect: "error",
        });
        return { response: {
          statusCode: response.status,
          headers: Object.fromEntries(response.headers),
          body: response.body ? Readable.fromWeb(response.body as import("node:stream/web").ReadableStream) : Readable.from([]),
        } };
      },
    },
  }));
  const statusOf = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  const missing = (error: unknown) => statusOf(error) === 404;
  const translate = (error: unknown, operation: string, key?: string): never => {
    if (statusOf(error) === 412) throw new ObjectExistsError(key ?? "");
    throw new R2RequestError(statusOf(error) ?? 0, null, operation, key, error);
  };
  async function putBuffer(key: string, body: Buffer, options: StoragePutOptions) {
    const { PutObjectCommand } = await sdk();
    try {
      await (await client()).send(new PutObjectCommand({
        Bucket: config.bucket, Key: key, Body: body,
        ContentType: options.contentType, CacheControl: PRIVATE_CACHE_CONTROL,
        ...(options.overwrite ? {} : { IfNoneMatch: "*" }),
      }), { abortSignal: options.signal });
    } catch (error) { translate(error, "PutObject", key); }
  }
  async function putMultipart(key: string, body: AsyncIterable<Buffer | Uint8Array>, options: StoragePutOptions) {
    const { CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = await sdk();
    const s3 = await client();
    let uploadId: string | undefined;
    /* Set the moment a request that can create the object is sent: after it,
       a failure no longer proves nothing was written. */
    let committing = false;
    const abort = async () => {
      if (uploadId) await s3.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId }), { abortSignal: AbortSignal.timeout(R2_ABORT_TIMEOUT_MS) });
    };
    try {
      const created = await s3.send(new CreateMultipartUploadCommand({ Bucket: config.bucket, Key: key, ContentType: options.contentType, CacheControl: PRIVATE_CACHE_CONTROL }), { abortSignal: options.signal });
      uploadId = created.UploadId;
      if (!uploadId) throw new Error("Storage did not acknowledge the multipart upload.");
      const parts: { PartNumber: number; ETag: string }[] = [];
      const upload = async (bytes: Buffer) => {
        if (parts.length >= R2_MAX_PARTS) throw new Error("Multipart upload exceeds the part limit.");
        const PartNumber = parts.length + 1;
        const result = await s3.send(new UploadPartCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumber, Body: bytes }), { abortSignal: options.signal });
        if (!result.ETag) throw new Error("Storage did not acknowledge an uploaded part.");
        parts.push({ PartNumber, ETag: result.ETag });
      };
      let pending = Buffer.alloc(R2_PART_SIZE), length = 0;
      for await (const chunk of body) {
        const bytes = toBuffer(chunk);
        for (let offset = 0; offset < bytes.length;) {
          const take = Math.min(R2_PART_SIZE - length, bytes.length - offset);
          bytes.copy(pending, length, offset, offset + take);
          offset += take; length += take;
          if (length === R2_PART_SIZE) { await upload(pending); pending = Buffer.alloc(R2_PART_SIZE); length = 0; }
        }
      }
      if (length) await upload(pending.subarray(0, length));
      if (!parts.length) { await abort(); uploadId = undefined; committing = true; await putBuffer(key, Buffer.alloc(0), options); return; }
      committing = true;
      await s3.send(new CompleteMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts }, ...(options.overwrite ? {} : { IfNoneMatch: "*" }) }), { abortSignal: options.signal });
    } catch (error) {
      // No upload id: none was created, or Create's answer was lost (an
      // orphaned upload is not an object; the bucket's lifecycle rule ends it).
      let aborted = !uploadId;
      if (uploadId) await abort().then(() => { aborted = true; }, () => {});
      try { translate(error, "MultipartUpload", key); }
      catch (translated) { throw aborted && !committing ? markNothingWritten(translated) : translated; }
    }
  }
  return {
    kind: "r2",
    async put(key, body, options) {
      await withRecoveryActivity("r2-put", async () => {
        if (Buffer.isBuffer(body) && body.length <= R2_MULTIPART_THRESHOLD && !options.multipart) await putBuffer(key, body, options);
        else await putMultipart(key, Buffer.isBuffer(body) ? (async function* () { yield body; })() : body, options);
      }, { uncertainOnError: uncertainUnlessExists });
    },
    async get(key, options = {}) {
      if (/^https?:\/\//.test(key)) throw new Error("The R2 backend reads keys, not URLs.");
      const { GetObjectCommand } = await sdk();
      try {
        const out = await (await client()).send(new GetObjectCommand({ Bucket: config.bucket, Key: key, ...(options.range ? { Range: `bytes=${options.range.start}-${options.range.end}` } : {}) }), { abortSignal: options.signal });
        if (!out.Body) throw new Error("Storage returned no response body.");
        const headers = new Headers();
        if (out.ContentLength != null) headers.set("content-length", String(out.ContentLength));
        if (out.ContentRange) headers.set("content-range", out.ContentRange);
        if (out.ContentType) headers.set("content-type", out.ContentType);
        if (out.ContentEncoding) headers.set("content-encoding", out.ContentEncoding);
        if (out.CacheControl) headers.set("cache-control", out.CacheControl);
        if (out.AcceptRanges) headers.set("accept-ranges", out.AcceptRanges);
        return { stream: out.Body.transformToWebStream(), headers, statusCode: out.$metadata.httpStatusCode ?? 200 };
      } catch (error) { if (missing(error)) return null; return translate(error, "GetObject", key); }
    },
    async head(key) {
      const { HeadObjectCommand } = await sdk();
      try {
        const out = await (await client()).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        if (out.ContentLength == null || !Number.isSafeInteger(out.ContentLength) || out.ContentLength < 0) throw new Error("Storage returned no object length.");
        return { size: out.ContentLength };
      } catch (error) { if (missing(error)) return null; return translate(error, "HeadObject", key); }
    },
    async del(keys) {
      if (!keys.length) return;
      const { DeleteObjectsCommand, DeleteObjectCommand } = await sdk();
      const s3 = await client();
      await withRecoveryActivity("r2-delete", async () => {
        for (let start = 0; start < keys.length; start += DELETE_BATCH) {
          const batch = keys.slice(start, start + DELETE_BATCH);
          let failed: string[];
          try {
            const out = await s3.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true } }));
            failed = (out.Errors ?? []).map(error => error.Key).filter((key): key is string => Boolean(key));
            if ((out.Errors?.length ?? 0) !== failed.length) throw new Error("Storage returned an incomplete deletion result.");
          } catch { failed = batch; }
          for (const key of failed) {
            try { await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })); }
            catch (error) { if (!missing(error)) translate(error, "DeleteObject", key); }
          }
        }
      }, { uncertainOnError: true });
    },
    async list(options = {}) {
      const { ListObjectsV2Command } = await sdk();
      try {
        const out = await (await client()).send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: options.prefix, ContinuationToken: options.cursor, MaxKeys: Math.max(1, Math.min(1000, options.limit ?? 1000)) }));
        return { items: (out.Contents ?? []).map(item => {
          if (!item.Key) throw new Error("Storage returned an unnamed object.");
          return { key: item.Key, size: item.Size ?? 0, uploadedAt: item.LastModified ?? new Date(0), ...(item.ETag ? { etag: item.ETag.replace(/^"|"$/g, "") } : {}) };
        }), ...(out.NextContinuationToken ? { cursor: out.NextContinuationToken } : {}), hasMore: out.IsTruncated ?? false };
      } catch (error) { return translate(error, "ListObjectsV2"); }
    },
    async presignGet(key, validUntilMs, options = {}) {
      const date = now();
      if (!Number.isFinite(validUntilMs) || validUntilMs <= date.getTime()) throw new Error("The storage download expiry must be in the future.");
      const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([sdk(), import("@aws-sdk/s3-request-presigner")]);
      return getSignedUrl(await client(), new GetObjectCommand({
        Bucket: config.bucket, Key: key, ResponseCacheControl: "private, no-store",
        ...(options.contentDisposition ? { ResponseContentDisposition: options.contentDisposition } : {}),
        ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
      }), { expiresIn: Math.min(PRESIGN_MAX_SECONDS, Math.ceil((validUntilMs - date.getTime()) / 1000)), signingDate: date });
    },
  };
}
