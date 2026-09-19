import { createHash, createHmac } from "node:crypto";
import { withRecoveryActivity } from "../recovery";
import {
  ObjectExistsError,
  uncertainUnlessExists,
  type StorageBackend,
  type StorageBody,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListResult,
  type StoragePresignOptions,
  type StoragePutOptions,
} from "./types";

/**
 * Cloudflare R2 over the S3 REST API, signed with AWS Signature Version 4
 * from node:crypto and sent with fetch. No SDK: the production bundle stays
 * private and small, and every byte on the wire is visible here.
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
const PRESIGN_MAX_SECONDS = 7 * 24 * 3600;

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

/* ── XML, the little S3 needs ──────────────────────────────────────────── */

const unescapeXml = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (_, name: string, dec?: string, hex?: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? "\"" : name === "apos" ? "'"
      : String.fromCodePoint(dec ? Number(dec) : parseInt(hex!, 16)));

const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[c]!);

const xmlText = (xml: string, tag: string): string | null => {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1]) : null;
};

const xmlBlocks = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);

/** A non-success S3 response. Carries the status and S3 code, never a credential. */
export class R2RequestError extends Error {
  constructor(readonly status: number, readonly code: string | null, readonly operation: string, key?: string) {
    super(`R2 ${operation}${key ? ` ${key}` : ""} failed (${status}${code ? ` ${code}` : ""})`);
    this.name = "R2RequestError";
  }
}

const toBuffer = (chunk: Buffer | Uint8Array): Buffer =>
  Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

const emptyStream = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

/* ── Backend ───────────────────────────────────────────────────────────── */

export function createR2Backend(config: R2Config, deps: R2Dependencies = {}): StorageBackend {
  const fetchImpl: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  const base = config.endpoint.replace(/\/+$/, "");
  const bucketUrl = (key: string | null) => new URL(`${base}/${rfc3986(config.bucket)}${key === null ? "" : `/${encodeKey(key)}`}`);

  type RequestOptions = {
    query?: Record<string, string>;
    headers?: Record<string, string>;
    /** Sent but not signed. */
    unsigned?: Record<string, string>;
    body?: Buffer;
    signal?: AbortSignal;
    /** Statuses returned to the caller instead of thrown. */
    allow?: number[];
    operation: string;
  };

  async function request(method: string, key: string | null, options: RequestOptions): Promise<Response> {
    const signed = signRequest({
      method,
      url: bucketUrl(key),
      query: options.query,
      headers: options.headers,
      payloadHash: options.body ? sha256Hex(options.body) : EMPTY_SHA256,
      credentials,
      region: R2_REGION,
      date: now(),
    });
    const response = await fetchImpl(signed.url, {
      method,
      headers: { ...signed.headers, ...(options.unsigned ?? {}) },
      ...(options.body ? { body: new Uint8Array(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.ok || options.allow?.includes(response.status)) return response;
    const text = await response.text().catch(() => "");
    throw new R2RequestError(response.status, xmlText(text, "Code"), options.operation, key ?? undefined);
  }

  async function putObject(key: string, body: Buffer, options: StoragePutOptions): Promise<void> {
    const response = await request("PUT", key, {
      headers: { "content-type": options.contentType, ...(options.overwrite ? {} : { "if-none-match": "*" }) },
      body,
      signal: options.signal,
      allow: options.overwrite ? [] : [412],
      operation: "PutObject",
    });
    if (response.status === 412) throw new ObjectExistsError(key);
  }

  async function abortMultipart(key: string, uploadId: string): Promise<void> {
    await request("DELETE", key, { query: { uploadId }, allow: [404], operation: "AbortMultipartUpload" });
  }

  async function putMultipart(key: string, body: AsyncIterable<Buffer | Uint8Array>, options: StoragePutOptions): Promise<void> {
    const created = await request("POST", key, {
      query: { uploads: "" },
      headers: { "content-type": options.contentType },
      signal: options.signal,
      operation: "CreateMultipartUpload",
    });
    const uploadId = xmlText(await created.text(), "UploadId");
    if (!uploadId) throw new R2RequestError(created.status, null, "CreateMultipartUpload", key);

    const parts: { number: number; etag: string }[] = [];
    const uploadPart = async (bytes: Buffer) => {
      const number = parts.length + 1;
      if (number > R2_MAX_PARTS) throw new Error(`Upload ${key} needs more than ${R2_MAX_PARTS} parts.`);
      const response = await request("PUT", key, {
        query: { partNumber: String(number), uploadId },
        body: bytes,
        signal: options.signal,
        operation: "UploadPart",
      });
      const etag = response.headers.get("etag");
      if (!etag) throw new R2RequestError(response.status, null, "UploadPart", key);
      parts.push({ number, etag });
    };

    try {
      let pending: Buffer[] = [], pendingBytes = 0;
      for await (const chunk of body) {
        const bytes = toBuffer(chunk);
        if (!bytes.length) continue;
        pending.push(bytes);
        pendingBytes += bytes.length;
        while (pendingBytes >= R2_PART_SIZE) {
          const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
          await uploadPart(joined.subarray(0, R2_PART_SIZE));
          const rest = joined.subarray(R2_PART_SIZE);
          pending = rest.length ? [rest] : [];
          pendingBytes = rest.length;
        }
      }
      if (pendingBytes) await uploadPart(pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes));
      if (!parts.length) {
        // Nothing arrived: S3 wants at least one part, so the empty object is a plain put.
        await abortMultipart(key, uploadId);
        await putObject(key, Buffer.alloc(0), options);
        return;
      }
      const completion = Buffer.from(
        `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`,
      );
      const completed = await request("POST", key, {
        query: { uploadId },
        headers: { "content-type": "application/xml", ...(options.overwrite ? {} : { "if-none-match": "*" }) },
        body: completion,
        signal: options.signal,
        allow: options.overwrite ? [] : [412],
        operation: "CompleteMultipartUpload",
      });
      if (completed.status === 412) throw new ObjectExistsError(key);
      // S3 may answer 200 with an error document once the parts are being joined.
      const text = await completed.text();
      if (/<Error>/.test(text)) throw new R2RequestError(completed.status, xmlText(text, "Code"), "CompleteMultipartUpload", key);
    } catch (error) {
      await abortMultipart(key, uploadId).catch(() => {});
      throw error;
    }
  }

  async function deleteEach(keys: string[]): Promise<void> {
    for (const key of keys) await request("DELETE", key, { allow: [404], operation: "DeleteObject" });
  }

  async function deleteBatch(keys: string[]): Promise<void> {
    const body = Buffer.from(
      `<Delete><Quiet>true</Quiet>${keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("")}</Delete>`,
    );
    let text: string;
    try {
      const response = await request("POST", null, {
        query: { delete: "" },
        headers: { "content-type": "application/xml", "content-md5": createHash("md5").update(body).digest("base64") },
        body,
        operation: "DeleteObjects",
      });
      text = await response.text();
    } catch {
      // A store without batch deletion still honours one DELETE per key.
      await deleteEach(keys);
      return;
    }
    const failed = xmlBlocks(text, "Error").map((block) => xmlText(block, "Key")).filter((key): key is string => key !== null);
    if (failed.length) await deleteEach(failed);
  }

  return {
    kind: "r2",

    async put(key: string, body: StorageBody, options: StoragePutOptions): Promise<void> {
      await withRecoveryActivity("r2-put", async () => {
        if (Buffer.isBuffer(body)) await putObject(key, body, options);
        else await putMultipart(key, body as AsyncIterable<Buffer | Uint8Array>, options);
      }, { uncertainOnError: uncertainUnlessExists });
    },

    async get(keyOrUrl: string, options: StorageGetOptions = {}): Promise<StorageGetResult | null> {
      if (/^https?:\/\//.test(keyOrUrl)) throw new Error("The R2 backend reads keys, not URLs.");
      const { range, signal, identity } = options;
      const response = await request("GET", keyOrUrl, {
        ...(range ? { headers: { range: `bytes=${range.start}-${range.end}` } } : {}),
        ...(range || identity ? { unsigned: { "accept-encoding": "identity" } } : {}),
        signal,
        allow: [404],
        operation: "GetObject",
      });
      if (response.status === 404) return null;
      return { stream: response.body ?? emptyStream(), headers: response.headers, statusCode: response.status };
    },

    async head(key: string): Promise<{ size: number } | null> {
      const response = await request("HEAD", key, { allow: [404], operation: "HeadObject" });
      if (response.status === 404) return null;
      const length = response.headers.get("content-length");
      if (length === null || !/^\d+$/.test(length)) throw new R2RequestError(response.status, null, "HeadObject", key);
      return { size: Number(length) };
    },

    async del(keys: string[]): Promise<void> {
      if (!keys.length) return;
      await withRecoveryActivity("r2-delete", async () => {
        for (let i = 0; i < keys.length; i += DELETE_BATCH) await deleteBatch(keys.slice(i, i + DELETE_BATCH));
      }, { uncertainOnError: true });
    },

    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<StorageListResult> {
      const response = await request("GET", null, {
        query: {
          "list-type": "2",
          "max-keys": String(Math.max(1, Math.min(1000, options.limit ?? 1000))),
          ...(options.prefix ? { prefix: options.prefix } : {}),
          ...(options.cursor ? { "continuation-token": options.cursor } : {}),
        },
        operation: "ListObjectsV2",
      });
      const xml = await response.text();
      const items = xmlBlocks(xml, "Contents").map((block) => {
        const key = xmlText(block, "Key");
        if (key === null) throw new R2RequestError(response.status, null, "ListObjectsV2");
        const etag = xmlText(block, "ETag");
        return {
          key,
          size: Number(xmlText(block, "Size") ?? 0),
          uploadedAt: new Date(xmlText(block, "LastModified") ?? 0),
          ...(etag ? { etag: etag.replace(/^"|"$/g, "") } : {}),
        };
      });
      const cursor = xmlText(xml, "NextContinuationToken");
      return { items, ...(cursor ? { cursor } : {}), hasMore: xmlText(xml, "IsTruncated") === "true" };
    },

    async presignGet(key: string, validUntilMs: number, options: StoragePresignOptions = {}): Promise<string> {
      const date = now();
      const expiresSeconds = Math.max(1, Math.min(PRESIGN_MAX_SECONDS, Math.ceil((validUntilMs - date.getTime()) / 1000)));
      return presignRequest({
        method: "GET",
        url: bucketUrl(key),
        query: {
          ...(options.contentDisposition ? { "response-content-disposition": options.contentDisposition } : {}),
          ...(options.contentType ? { "response-content-type": options.contentType } : {}),
        },
        credentials,
        region: R2_REGION,
        date,
        expiresSeconds,
      }).url;
    },
  };
}
