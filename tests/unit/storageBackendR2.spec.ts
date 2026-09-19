import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { currentTenant, runInTenant, type TenantWorkspace } from "../../lib/tenant";
import {
  EMPTY_SHA256,
  R2_PART_SIZE,
  UNSIGNED_PAYLOAD,
  createR2Backend,
  presignRequest,
  sha256Hex,
  signRequest,
  type R2Config,
} from "../../lib/storage/r2";
import { ObjectExistsError, backendKind, isObjectExistsError, r2ConfigFromEnv, resolveStored } from "../../lib/storage/backend";
import { loadIsolated } from "./storageSeam";

/* ── An in-memory S3 behind fetch ────────────────────────────────────────
 * Verifies every request's SigV4 signature from what is on the wire (path,
 * query, signed headers, payload hash), enforces If-None-Match, Range,
 * multipart part rules and pagination, and can be told to misbehave.
 * ---------------------------------------------------------------------- */

const CONFIG: R2Config = {
  accountId: "0123456789abcdef",
  accessKeyId: "AKIAFAKEACCESSKEYID",
  secretAccessKey: "fake-secret-access-key-never-real",
  bucket: "particl-test",
  endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
};

type Call = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: Buffer };

const xml = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "application/xml", ...headers } });
const s3Error = (status: number, code: string) => xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);
const parseAmzDate = (stamp: string) =>
  new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15)));

class FakeS3 {
  objects = new Map<string, { bytes: Buffer; contentType: string }>();
  uploads = new Map<string, { key: string; contentType: string; parts: Map<number, Buffer> }>();
  calls: Call[] = [];
  aborted: string[] = [];
  cancelled = 0;
  failPart: number | null = null;
  rangeMisbehaves = false;
  batchDeleteFails = false;
  private uploadCounter = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const query = Object.fromEntries(url.searchParams);
    this.calls.push({ method, path: url.pathname, query, headers, body });

    const denied = this.verify(method, url, query, headers, body);
    if (denied) return denied;

    const segments = url.pathname.split("/").slice(1);
    if (segments[0] !== CONFIG.bucket) return s3Error(404, "NoSuchBucket");
    const key = segments.length > 1 ? segments.slice(1).map(decodeURIComponent).join("/") : null;

    if (key === null) {
      if (method === "GET" && query["list-type"] === "2") return this.list(query);
      if (method === "POST" && "delete" in query) return this.deleteObjects(body);
      return s3Error(400, "InvalidRequest");
    }
    if (method === "POST" && "uploads" in query) return this.createUpload(key, headers["content-type"] ?? "application/octet-stream");
    if (method === "PUT" && query.uploadId) return this.uploadPart(key, query.uploadId, Number(query.partNumber), body);
    if (method === "POST" && query.uploadId) return this.complete(key, query.uploadId, body, headers);
    if (method === "DELETE" && query.uploadId) { this.aborted.push(query.uploadId); this.uploads.delete(query.uploadId); return new Response(null, { status: 204 }); }
    if (method === "PUT") return this.putObject(key, body, headers);
    if (method === "GET") return this.getObject(key, headers);
    if (method === "HEAD") { const o = this.objects.get(key); return o ? new Response(null, { status: 200, headers: { "content-length": String(o.bytes.length), "content-type": o.contentType } }) : new Response(null, { status: 404 }); }
    if (method === "DELETE") { this.objects.delete(key); return new Response(null, { status: 204 }); }
    return s3Error(405, "MethodNotAllowed");
  };

  private verify(method: string, url: URL, query: Record<string, string>, headers: Record<string, string>, body: Buffer): Response | null {
    const bare = new URL(url.origin + url.pathname);
    const credentials = { accessKeyId: CONFIG.accessKeyId, secretAccessKey: CONFIG.secretAccessKey };
    if (query["X-Amz-Signature"]) {
      const { "X-Amz-Signature": given, "X-Amz-Algorithm": _a, "X-Amz-Credential": credential, "X-Amz-Date": date, "X-Amz-Expires": expires, "X-Amz-SignedHeaders": signed, ...rest } = query;
      void _a;
      if (!credential?.startsWith(`${CONFIG.accessKeyId}/`) || signed !== "host") return s3Error(403, "InvalidAccessKeyId");
      const expected = presignRequest({ method, url: bare, query: rest, credentials, region: "auto", date: parseAmzDate(date), expiresSeconds: Number(expires) });
      return expected.signature === given ? null : s3Error(403, "SignatureDoesNotMatch");
    }
    const auth = headers.authorization?.match(/^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
    if (!auth) return s3Error(403, "AccessDenied");
    if (!auth[1].startsWith(`${CONFIG.accessKeyId}/`) || !auth[1].endsWith("/auto/s3/aws4_request")) return s3Error(403, "InvalidAccessKeyId");
    const payloadHash = headers["x-amz-content-sha256"];
    if (payloadHash !== UNSIGNED_PAYLOAD && payloadHash !== sha256Hex(body)) return s3Error(400, "XAmzContentSHA256Mismatch");
    const signedNames = auth[2].split(";");
    for (const name of ["host", "x-amz-date", "x-amz-content-sha256"]) if (!signedNames.includes(name)) return s3Error(403, "AccessDenied");
    const signedHeaders: Record<string, string> = {};
    for (const name of signedNames) {
      if (name === "host" || name === "x-amz-date" || name === "x-amz-content-sha256") continue;
      if (!(name in headers)) return s3Error(403, "SignatureDoesNotMatch");
      signedHeaders[name] = headers[name];
    }
    const expected = signRequest({ method, url: bare, query, headers: signedHeaders, payloadHash, credentials, region: "auto", date: parseAmzDate(headers["x-amz-date"]) });
    return expected.signature === auth[3] ? null : s3Error(403, "SignatureDoesNotMatch");
  }

  private putObject(key: string, body: Buffer, headers: Record<string, string>): Response {
    if (headers["if-none-match"] === "*" && this.objects.has(key)) return s3Error(412, "PreconditionFailed");
    this.objects.set(key, { bytes: body, contentType: headers["content-type"] ?? "application/octet-stream" });
    return new Response(null, { status: 200, headers: { etag: `"${createHash("md5").update(body).digest("hex")}"` } });
  }

  private getObject(key: string, headers: Record<string, string>): Response {
    const object = this.objects.get(key);
    if (!object) return s3Error(404, "NoSuchKey");
    const range = !this.rangeMisbehaves && headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    const bytes = range ? object.bytes.subarray(Number(range[1]), Number(range[2]) + 1) : object.bytes;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => { c.enqueue(new Uint8Array(bytes)); c.close(); },
      cancel: () => { this.cancelled++; },
    });
    return new Response(stream, {
      status: range ? 206 : 200,
      headers: {
        "content-type": object.contentType,
        "content-length": String(bytes.length),
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${range[1]}-${range[2]}/${object.bytes.length}` } : {}),
      },
    });
  }

  private createUpload(key: string, contentType: string): Response {
    const id = `upload-${++this.uploadCounter}`;
    this.uploads.set(id, { key, contentType, parts: new Map() });
    return xml(`<InitiateMultipartUploadResult><Bucket>${CONFIG.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }

  private uploadPart(key: string, uploadId: string, number: number, body: Buffer): Response {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) return s3Error(404, "NoSuchUpload");
    if (this.failPart === number) return s3Error(500, "InternalError");
    upload.parts.set(number, body);
    return new Response(null, { status: 200, headers: { etag: `"${createHash("md5").update(body).digest("hex")}"` } });
  }

  private complete(key: string, uploadId: string, body: Buffer, headers: Record<string, string>): Response {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) return s3Error(404, "NoSuchUpload");
    const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>&quot;([0-9a-f]+)&quot;<\/ETag>/g)].map((m) => ({ number: Number(m[1]), etag: m[2] }));
    const ordered = [...upload.parts.keys()].sort((a, b) => a - b);
    if (listed.length !== ordered.length || listed.some((p, i) => p.number !== ordered[i] || createHash("md5").update(upload.parts.get(p.number)!).digest("hex") !== p.etag)) return s3Error(400, "InvalidPart");
    if (ordered.slice(0, -1).some((n) => upload.parts.get(n)!.length < 5 * 1024 * 1024)) return s3Error(400, "EntityTooSmall");
    if (headers["if-none-match"] === "*" && this.objects.has(key)) return s3Error(412, "PreconditionFailed");
    this.objects.set(key, { bytes: Buffer.concat(ordered.map((n) => upload.parts.get(n)!)), contentType: upload.contentType });
    this.uploads.delete(uploadId);
    return xml(`<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`);
  }

  private list(query: Record<string, string>): Response {
    const keys = [...this.objects.keys()].filter((k) => !query.prefix || k.startsWith(query.prefix)).sort();
    const start = query["continuation-token"] ? Number(query["continuation-token"]) : 0;
    const max = Number(query["max-keys"] ?? 1000);
    const page = keys.slice(start, start + max);
    const truncated = start + max < keys.length;
    const contents = page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>2026-09-19T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>${this.objects.get(k)!.bytes.length}</Size></Contents>`).join("");
    return xml(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ""}</ListBucketResult>`);
  }

  private deleteObjects(body: Buffer): Response {
    if (this.batchDeleteFails) return s3Error(501, "NotImplemented");
    for (const m of body.toString().matchAll(/<Key>([^<]*)<\/Key>/g)) this.objects.delete(m[1].replace(/&amp;/g, "&"));
    return xml("<DeleteResult></DeleteResult>");
  }
}

const backendFor = (fake: FakeS3) => createR2Backend(CONFIG, { fetch: fake.fetch });

/* ── SigV4 against the documented AWS example ─────────────────────────── */

test("SigV4 reproduces the signature of the AWS-documented S3 GET example", () => {
  const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const date = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));
  const signed = signRequest({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: { Range: "bytes=0-9" },
    payloadHash: EMPTY_SHA256,
    credentials,
    region: "us-east-1",
    date,
  });
  expect(signed.canonicalRequest).toBe([
    "GET",
    "/test.txt",
    "",
    "host:examplebucket.s3.amazonaws.com",
    "range:bytes=0-9",
    "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "x-amz-date:20130524T000000Z",
    "",
    "host;range;x-amz-content-sha256;x-amz-date",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ].join("\n"));
  expect(signed.stringToSign).toBe([
    "AWS4-HMAC-SHA256",
    "20130524T000000Z",
    "20130524/us-east-1/s3/aws4_request",
    "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
  ].join("\n"));
  expect(signed.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  expect(signed.headers.authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  expect(signed.headers["x-amz-date"]).toBe("20130524T000000Z");
  expect(signed.url).toBe("https://examplebucket.s3.amazonaws.com/test.txt");

  const presigned = presignRequest({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), credentials, region: "us-east-1", date, expiresSeconds: 86400 });
  expect(presigned.canonicalRequest).toBe([
    "GET",
    "/test.txt",
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
    "host:examplebucket.s3.amazonaws.com",
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n"));
  expect(presigned.signature).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  expect(presigned.url).toBe(
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

/* ── Selector ─────────────────────────────────────────────────────────── */

test("the selector defaults from the Blob token, refuses unknown values and names missing R2 variables without values", () => {
  expect(backendKind({})).toBe("local");
  expect(backendKind({ BLOB_READ_WRITE_TOKEN: "t" })).toBe("blob");
  expect(backendKind({ BLOB_READ_WRITE_TOKEN: "t", STORAGE_BACKEND: "r2" })).toBe("r2");
  expect(backendKind({ STORAGE_BACKEND: " Local " })).toBe("local");
  expect(() => backendKind({ STORAGE_BACKEND: "s3" })).toThrow(/Unknown STORAGE_BACKEND/);
  expect(() => r2ConfigFromEnv({ R2_ACCOUNT_ID: "acct", R2_SECRET_ACCESS_KEY: "hunter2" })).toThrow(/R2_ACCESS_KEY_ID, R2_BUCKET are not set/);
  expect(() => r2ConfigFromEnv({ R2_ACCOUNT_ID: "acct", R2_SECRET_ACCESS_KEY: "hunter2" })).not.toThrow(/hunter2/);
  const config = r2ConfigFromEnv({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET: "b" });
  expect(config.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
  expect(resolveStored("/api/media/gen_1")).toBeNull();
  expect(resolveStored("/api/uploads/up_1")).toBeNull();
  expect(resolveStored("")).toBeNull();
  const publicBlob = resolveStored("https://abc.public.blob.vercel-storage.com/uploads/x-Rand0m.png");
  expect(publicBlob).toMatchObject({ key: "https://abc.public.blob.vercel-storage.com/uploads/x-Rand0m.png", publicUrl: true });
  expect(publicBlob!.backend.kind).toBe("blob");
  expect(resolveStored("https://abc.private.blob.vercel-storage.com/uploads/x.png")).toMatchObject({ publicUrl: false });
  expect(() => resolveStored("https://cdn.example.com/x.png")).toThrow(/known storage backend/);
  expect(() => resolveStored("https://evil.example/?host=.public.blob.vercel-storage.com/")).toThrow(/known storage backend/);
});

/* ── Conditional put and the caller's verify path ─────────────────────── */

test("PutObject with If-None-Match maps 412 to ObjectExistsError and storeVideoBytes verifies instead of overwriting", async () => {
  const fake = new FakeS3();
  const backend = backendFor(fake);
  const first = Buffer.from("first original bytes");
  await backend.put("generations/one.mp4", first, { contentType: "video/mp4", overwrite: false });
  expect(fake.calls.at(-1)).toMatchObject({ method: "PUT", path: `/${CONFIG.bucket}/generations/one.mp4`, headers: { "if-none-match": "*", "content-type": "video/mp4" } });
  const again = backend.put("generations/one.mp4", Buffer.from("other bytes"), { contentType: "video/mp4", overwrite: false });
  await expect(again).rejects.toBeInstanceOf(ObjectExistsError);
  await again.catch((error) => expect(isObjectExistsError(error)).toBe(true));
  expect(fake.objects.get("generations/one.mp4")!.bytes).toEqual(first);
  await backend.put("generations/one.mp4", Buffer.from("replaced"), { contentType: "video/mp4", overwrite: true });
  expect(fake.calls.at(-1)!.headers["if-none-match"]).toBeUndefined();
  expect(fake.objects.get("generations/one.mp4")!.bytes).toEqual(Buffer.from("replaced"));
  expect(await backend.head("generations/one.mp4")).toEqual({ size: 8 });
  expect(await backend.head("generations/missing.mp4")).toBeNull();

  // The real lib/storage.ts, selected onto R2 with the fake behind fetch.
  const storage = loadIsolated<typeof import("../../lib/storage")>("lib/storage.ts", { "./tenant": { currentTenant } }, {
    fetch: fake.fetch,
    process: { ...process, env: { ...process.env, BLOB_READ_WRITE_TOKEN: "", STORAGE_BACKEND: "r2", R2_ACCOUNT_ID: CONFIG.accountId, R2_ACCESS_KEY_ID: CONFIG.accessKeyId, R2_SECRET_ACCESS_KEY: CONFIG.secretAccessKey, R2_BUCKET: CONFIG.bucket } },
  });
  expect(storage.backendKind()).toBe("r2");
  expect(storage.usingBlob()).toBe(true);
  expect(storage.usingCloud()).toBe(true);
  const original = Buffer.from("consumer original mp4 bytes");
  await runInTenant({ id: "r2-studio", legacy: false } as TenantWorkspace, async () => {
    const stored = await storage.storeVideoBytes("orig", original);
    expect(stored).toEqual({ url: "/api/media/orig", bytes: original.length, sha256: createHash("sha256").update(original).digest("hex") });
    expect(fake.objects.get("ws/r2-studio/generations/orig.mp4")!.bytes).toEqual(original);
    // A repeat with the same bytes hits 412 and verifies the stored hash.
    await expect(storage.storeVideoBytes("orig", original)).resolves.toMatchObject({ url: "/api/media/orig" });
    expect(fake.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/orig.mp4"))).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === "GET" && c.path.endsWith("/orig.mp4"))).toHaveLength(1);
    // Different bytes are refused and the original is untouched.
    await expect(storage.storeVideoBytes("orig", Buffer.from("tampered bytes that differ from the stored original"))).rejects.toThrow(/could not be verified/);
    expect(fake.objects.get("ws/r2-studio/generations/orig.mp4")!.bytes).toEqual(original);
    expect(await storage.readVideoBytes("orig")).toEqual(original);
    await storage.deleteVideo("orig", true);
    expect(fake.objects.has("ws/r2-studio/generations/orig.mp4")).toBe(false);
  });
});

/* ── Multipart ────────────────────────────────────────────────────────── */

test("multipart uploads assemble 3.5 MB chunks into 8 MiB parts and abort on a failed part", async () => {
  const fake = new FakeS3();
  const backend = backendFor(fake);
  const CHUNK = 3_500_000, COUNT = 5;
  async function* chunks(hash?: ReturnType<typeof createHash>) {
    for (let i = 0; i < COUNT; i++) {
      const chunk = Buffer.alloc(CHUNK, i + 1);
      hash?.update(chunk);
      yield chunk;
    }
  }
  const hash = createHash("sha256");
  await backend.put("uploads/big.bin", chunks(hash), { contentType: "application/octet-stream", overwrite: true, multipart: true });
  const parts = fake.calls.filter((c) => c.method === "PUT" && c.query.partNumber);
  expect(parts.map((c) => c.body.length)).toEqual([R2_PART_SIZE, R2_PART_SIZE, CHUNK * COUNT - 2 * R2_PART_SIZE]);
  expect(parts.map((c) => c.query.partNumber)).toEqual(["1", "2", "3"]);
  expect(fake.calls.map((c) => `${c.method} ${Object.keys(c.query).join(",")}`)).toEqual([
    "POST uploads", "PUT partNumber,uploadId", "PUT partNumber,uploadId", "PUT partNumber,uploadId", "POST uploadId",
  ]);
  expect(fake.calls[0].headers["content-type"]).toBe("application/octet-stream");
  const stored = fake.objects.get("uploads/big.bin")!;
  expect(stored.bytes.length).toBe(CHUNK * COUNT);
  expect(createHash("sha256").update(stored.bytes).digest("hex")).toBe(hash.digest("hex"));
  expect(fake.aborted).toEqual([]);
  expect(fake.uploads.size).toBe(0);

  fake.failPart = 2;
  fake.calls = [];
  await expect(backend.put("uploads/broken.bin", chunks(), { contentType: "application/octet-stream", overwrite: true, multipart: true })).rejects.toThrow(/UploadPart.*500/);
  expect(fake.aborted).toEqual(["upload-2"]);
  expect(fake.objects.has("uploads/broken.bin")).toBe(false);
  expect(fake.calls.at(-1)).toMatchObject({ method: "DELETE", query: { uploadId: "upload-2" } });
  expect(fake.calls.some((c) => c.method === "POST" && c.query.uploadId)).toBe(false);

  // A conditional multipart write of an existing key is a precondition failure, and the parts are abandoned.
  fake.failPart = null;
  await expect(backend.put("uploads/big.bin", chunks(), { contentType: "application/octet-stream", overwrite: false, multipart: true })).rejects.toBeInstanceOf(ObjectExistsError);
  expect(fake.aborted).toEqual(["upload-2", "upload-3"]);
});

/* ── Range reads through lib/storage.ts ───────────────────────────────── */

test("range reads forward Range with identity encoding and a mismatched content-range cancels the stream", async () => {
  const fake = new FakeS3();
  const bytes = Buffer.from("0123456789AB");
  fake.objects.set("ws/range-r2/uploads/clip.mp4", { bytes, contentType: "video/mp4" });
  fake.objects.set("ws/range-r2/generations/gen.mp4", { bytes, contentType: "video/mp4" });
  const storage = loadIsolated<typeof import("../../lib/storage")>("lib/storage.ts", { "./tenant": { currentTenant } }, {
    fetch: fake.fetch,
    process: { ...process, env: { ...process.env, BLOB_READ_WRITE_TOKEN: "", STORAGE_BACKEND: "r2", R2_ACCOUNT_ID: CONFIG.accountId, R2_ACCESS_KEY_ID: CONFIG.accessKeyId, R2_SECRET_ACCESS_KEY: CONFIG.secretAccessKey, R2_BUCKET: CONFIG.bucket } },
  });
  await runInTenant({ id: "range-r2", legacy: false } as TenantWorkspace, async () => {
    const range = { start: 4, end: 7, total: 12 };
    const result = await storage.openUploadStream("clip", "mp4", range, "/api/uploads/clip", AbortSignal.timeout(5_000));
    expect(result.size).toBe(4);
    expect(Buffer.from(await new Response(result.stream).arrayBuffer())).toEqual(Buffer.from("4567"));
    expect(fake.calls.at(-1)).toMatchObject({ method: "GET", path: `/${CONFIG.bucket}/ws/range-r2/uploads/clip.mp4`, headers: { range: "bytes=4-7", "accept-encoding": "identity" } });
    expect(fake.calls.at(-1)!.headers.authorization).toMatch(/SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);

    const video = await storage.openVideoStream("gen", range);
    expect(Buffer.from(await new Response(video).arrayBuffer())).toEqual(Buffer.from("4567"));

    const whole = await storage.openUploadStream("clip", "mp4", null);
    expect(whole.size).toBe(12);
    expect(fake.calls.at(-1)!.headers.range).toBeUndefined();
    expect(fake.calls.at(-1)!.headers["accept-encoding"]).toBe("identity");
    await whole.stream.cancel();

    fake.rangeMisbehaves = true;
    fake.cancelled = 0;
    await expect(storage.openUploadStream("clip", "mp4", range)).rejects.toThrow(/honor the requested media range/);
    await expect(storage.openVideoStream("gen", range)).rejects.toThrow(/honor the requested original range/);
    expect(fake.cancelled).toBe(2);
    await expect(storage.openUploadStream("absent", "mp4", null)).rejects.toThrow(/not found/);
  });
});

/* ── Listing and deletion ─────────────────────────────────────────────── */

test("ListObjectsV2 follows continuation tokens and DeleteObjects batches with a per-key fallback", async () => {
  const fake = new FakeS3();
  const backend = backendFor(fake);
  const keys = ["ws/a/chunks/s/0", "ws/a/chunks/s/1", "ws/a/chunks/s/2", "ws/a/uploads/u.bin", "ws/a/uploads/v&w.bin"];
  for (const key of keys) await backend.put(key, Buffer.from(key), { contentType: "application/octet-stream", overwrite: true });
  await backend.put("ws/b/uploads/other.bin", Buffer.from("other"), { contentType: "application/octet-stream", overwrite: true });

  const seen: string[] = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = await backend.list({ prefix: "ws/a/", limit: 2, cursor });
    pages++;
    seen.push(...page.items.map((item) => item.key));
    expect(page.items.every((item) => item.size === item.key.length && item.uploadedAt instanceof Date && item.etag === "abc")).toBe(true);
    if (page.hasMore) expect(page.cursor).toBeTruthy(); else expect(page.cursor).toBeUndefined();
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen).toEqual(keys);
  const listCalls = fake.calls.filter((c) => c.query["list-type"] === "2");
  expect(listCalls.map((c) => c.query["continuation-token"])).toEqual([undefined, "2", "4"]);
  expect(listCalls.every((c) => c.query.prefix === "ws/a/" && c.query["max-keys"] === "2")).toBe(true);
  expect((await backend.list({ prefix: "ws/none/" })).items).toEqual([]);

  fake.calls = [];
  await backend.del(keys.slice(0, 3));
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]).toMatchObject({ method: "POST", path: `/${CONFIG.bucket}`, query: { delete: "" } });
  expect(fake.calls[0].headers["content-md5"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  expect(fake.calls[0].body.toString()).toBe("<Delete><Quiet>true</Quiet><Object><Key>ws/a/chunks/s/0</Key></Object><Object><Key>ws/a/chunks/s/1</Key></Object><Object><Key>ws/a/chunks/s/2</Key></Object></Delete>");
  expect([...fake.objects.keys()].sort()).toEqual(["ws/a/uploads/u.bin", "ws/a/uploads/v&w.bin", "ws/b/uploads/other.bin"]);

  fake.batchDeleteFails = true;
  fake.calls = [];
  await backend.del(["ws/a/uploads/u.bin", "ws/a/uploads/v&w.bin", "ws/a/uploads/gone.bin"]);
  expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
    `POST /${CONFIG.bucket}`,
    `DELETE /${CONFIG.bucket}/ws/a/uploads/u.bin`,
    `DELETE /${CONFIG.bucket}/ws/a/uploads/v%26w.bin`,
    `DELETE /${CONFIG.bucket}/ws/a/uploads/gone.bin`,
  ]);
  expect([...fake.objects.keys()]).toEqual(["ws/b/uploads/other.bin"]);
  await backend.del([]);
  expect(fake.calls).toHaveLength(4);
});

/* ── Presigned GET ────────────────────────────────────────────────────── */

test("presigned GET URLs carry the signature and response headers and read back through the store", async () => {
  const fake = new FakeS3();
  const now = new Date(Date.UTC(2026, 8, 19, 12, 0, 0));
  const backend = createR2Backend(CONFIG, { fetch: fake.fetch, now: () => now });
  fake.objects.set("ws/x/uploads/movie (1).mp4", { bytes: Buffer.from("movie bytes"), contentType: "video/mp4" });
  const url = await backend.presignGet("ws/x/uploads/movie (1).mp4", now.getTime() + 6 * 3600_000, {
    contentDisposition: "attachment; filename=\"movie (1).mp4\"",
    contentType: "video/mp4",
  });
  const parsed = new URL(url);
  expect(parsed.origin).toBe(CONFIG.endpoint);
  expect(parsed.pathname).toBe(`/${CONFIG.bucket}/ws/x/uploads/movie%20%281%29.mp4`);
  expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(parsed.searchParams.get("X-Amz-Credential")).toBe(`${CONFIG.accessKeyId}/20260919/auto/s3/aws4_request`);
  expect(parsed.searchParams.get("X-Amz-Date")).toBe("20260919T120000Z");
  expect(parsed.searchParams.get("X-Amz-Expires")).toBe("21600");
  expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  expect(parsed.searchParams.get("response-content-disposition")).toBe("attachment; filename=\"movie (1).mp4\"");
  expect(parsed.searchParams.get("response-content-type")).toBe("video/mp4");
  expect(url).not.toContain(CONFIG.secretAccessKey);
  expect(url).toContain("response-content-disposition=attachment%3B%20filename%3D%22movie%20%281%29.mp4%22");

  const response = await fake.fetch(url);
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("movie bytes"));
  const tampered = await fake.fetch(url.replace("response-content-type=video%2Fmp4", "response-content-type=text%2Fhtml"));
  expect(tampered.status).toBe(403);

  // Expiry is bounded to what S3 accepts.
  const far = new URL(await backend.presignGet("k", now.getTime() + 30 * 24 * 3600_000));
  expect(far.searchParams.get("X-Amz-Expires")).toBe(String(7 * 24 * 3600));
  const past = new URL(await backend.presignGet("k", now.getTime() - 1));
  expect(past.searchParams.get("X-Amz-Expires")).toBe("1");
});
