import net from "node:net";
import tls from "node:tls";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

/**
 * A standing network tripwire for every test that imports these fakes: no socket may be opened to anything but a local (IPC) path, whatever library asks. A stub of
 * globalThis.fetch is not enough (undici and the SDKs open sockets themselves), and one verify call without the fake Blob SDK once reached Vercel's real API with a fixture
 * token. Here that call throws instead, before a byte leaves the process.
 */
const isLocalPath = (first) => (typeof first === "string" && Number.isNaN(Number(first))) || (first && typeof first === "object" && typeof first.path === "string" && first.port === undefined);
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // net.connect hands connect() its normalized arguments: [options, callback] as one array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (isLocalPath(first)) return realConnect.apply(this, args);
  throw new Error("Network blocked: this test must not open a connection");
};
tls.connect = () => {
  throw new Error("Network blocked: this test must not open a connection");
};

/**
 * In-process fakes for the Blob to R2 tools' tests: an S3-compatible bucket behind the real client's command classes (list, get with Range) and an in-memory Blob SDK.
 * Nothing leaves the process and no credential is real.
 */
export const BLOB_ORIGIN = "https://fixture-store.private.blob.vercel-storage.com/";
export const W = "ws/ws_fixture/";
export const ENV = {
  BLOB_READ_WRITE_TOKEN: "fixture-blob-token-value",
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "fixture-access-key-id",
  R2_SECRET_ACCESS_KEY: "fixture-secret-access-key-value",
  R2_BUCKET: "fixture-bucket",
  // Never a real endpoint: should a test ever reach for the network, it reaches nothing (and the tripwire above stops it first).
  R2_ENDPOINT: "https://127.0.0.1:9",
};
export const fast = { sleep: async () => {} };
export const bytes = (label, size) => (size ? Buffer.alloc(size, label) : Buffer.from(`private ${label} bytes`));
const md5 = (body) => createHash("md5").update(body).digest("hex");
const sha = (body) => createHash("sha256").update(body).digest("hex");
const s3Error = (status, name) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

/** faults: Map of "<Command>:<key>" -> a status to throw. `sizeLies`: Map of key -> the total the server claims in Content-Range. */
export function fakeR2(initial = new Map()) {
  const objects = new Map(initial),
    calls = [],
    faults = new Map(),
    sizeLies = new Map();
  const client = {
    objects,
    calls,
    faults,
    sizeLies,
    destroy() {},
    async send(command) {
      const name = command.constructor.name,
        input = command.input;
      calls.push({ name, key: input.Key ?? null, range: input.Range ?? null });
      if (input.Bucket !== ENV.R2_BUCKET) throw new Error("wrong bucket");
      const fault = faults.get(`${name}:${input.Key}`);
      if (fault) throw s3Error(fault, "InjectedFault");
      if (name === "ListObjectsV2Command") {
        const keys = [...objects.keys()].sort(),
          offset = Number(input.ContinuationToken ?? 0),
          page = keys.slice(offset, offset + 2),
          more = offset + 2 < keys.length;
        return {
          Contents: page.map((Key) => ({ Key, Size: objects.get(Key).length, ETag: `"${md5(objects.get(Key))}"` })),
          IsTruncated: more,
          ...(more ? { NextContinuationToken: String(offset + 2) } : {}),
        };
      }
      if (name === "GetObjectCommand") {
        const body = objects.get(input.Key);
        if (!body) throw s3Error(404, "NoSuchKey");
        if (!input.Range) return { Body: Readable.from([body]), ContentLength: body.length };
        const match = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
        if (!match || body.length === 0) throw s3Error(416, "InvalidRange");
        const slice = body.subarray(Number(match[1]), Number(match[2]) + 1);
        return { Body: Readable.from([slice]), ContentLength: slice.length, ContentRange: `bytes ${match[1]}-${Number(match[1]) + slice.length - 1}/${sizeLies.get(input.Key) ?? body.length}` };
      }
      throw new Error(`Unexpected S3 command ${name}`);
    },
  };
  client.factory = () => client;
  return client;
}

/** Blob SDK fake: objects by pathname. `list` is all the census and verify use; `get` is recorded so a test can prove it was never called. */
export function fakeBlob(initial = new Map()) {
  const data = new Map(initial),
    reads = [];
  const urlOf = (pathname) => BLOB_ORIGIN + pathname.split("/").map(encodeURIComponent).join("/");
  return {
    data,
    reads,
    async list({ cursor, token }) {
      if (token !== ENV.BLOB_READ_WRITE_TOKEN) throw new Error("wrong token");
      const entries = [...data.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
        offset = Number(cursor ?? 0),
        page = entries.slice(offset, offset + 2);
      return {
        blobs: page.map(([pathname, body]) => ({ pathname, size: body.length, etag: `"blob-${sha(body)}"`, url: urlOf(pathname), uploadedAt: new Date(0) })),
        hasMore: offset + 2 < entries.length,
        cursor: String(offset + 2),
      };
    },
    async get(url) {
      reads.push(url);
      throw new Error("The census and the open check must not read Blob objects");
    },
  };
}
