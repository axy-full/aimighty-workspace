#!/usr/bin/env node
/**
 * A fake S3 / Cloudflare R2 endpoint for tests and load rehearsals.
 *
 * Plain node:http, no dependencies. Path-style addressing
 * (http://127.0.0.1:<port>/<bucket>/<key>); any bucket name is accepted and
 * every SigV4 Authorization header (or none) is accepted unchecked. Objects
 * and in-progress multipart parts live on DISK under `dir`, never in memory,
 * so a multi-GB rehearsal does not grow this process. Each stored object
 * keeps its sha256, size, content type and ETag in a JSON sidecar.
 *
 * Operations: CreateMultipartUpload, UploadPart, CompleteMultipartUpload
 * (If-None-Match: * answers 412 when the key exists), AbortMultipartUpload,
 * PutObject (If-None-Match too), GetObject (Range), HeadObject, DeleteObject,
 * DeleteObjects, ListObjectsV2 (prefix, max-keys, continuation-token).
 *
 * Test hooks: GET /__fake__/state answers JSON {objects, uploads, aborted,
 * completed, requests}; the in-process handle exposes the same through
 * state(), object(key) and close(). Fault injection: failNext(op, status)
 * (or POST /__fake__/fail?op=complete&status=500) makes the next request of
 * that operation answer `status` without doing anything. Operations: create,
 * uploadPart, complete, abort, put, get, head, delete.
 *
 * In process:  const s3 = await start({ dir, port: 0 }); s3.endpoint ...; await s3.close();
 * As a CLI:    node tests/helpers/fake-s3-server.mjs --port 9100 --dir /tmp/fake-s3
 *              prints {"endpoint":"http://127.0.0.1:9100","dir":"..."} on one line.
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
const xmlUnescape = (s) => s.replace(/&(lt|gt|amp|apos|quot);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' })[e]);
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';

function sendXml(res, status, body, headers = {}) {
  const buf = Buffer.from(XML_HEAD + body);
  res.writeHead(status, { "content-type": "application/xml", "content-length": buf.length, ...headers });
  res.end(buf);
}
function sendError(res, status, code, message = code, method = "GET") {
  if (method === "HEAD") { res.writeHead(status, { "x-amz-error-code": code }); res.end(); return; }
  sendXml(res, status, `<Error><Code>${code}</Code><Message>${xmlEscape(message)}</Message></Error>`);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
/** A body arriving with aws-chunked encoding (STREAMING-* payload hashes) carries
 *  chunk-signature framing; strip it so the stored bytes are the payload. */
function decodeAwsChunked(buf) {
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const eol = buf.indexOf("\r\n", at);
    if (eol < 0) break;
    const size = parseInt(buf.subarray(at, eol).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(size)) break;
    at = eol + 2;
    if (size === 0) break;
    out.push(buf.subarray(at, at + size));
    at += size + 2;
  }
  return Buffer.concat(out);
}

/** @param {{ dir?: string, port?: number, host?: string }} [options] */
export async function start(options = {}) {
  const { dir, port = 0, host = "127.0.0.1" } = options;
  const root = dir ?? mkdtempSync(path.join(tmpdir(), "fake-s3-"));
  const objectsDir = path.join(root, "objects"), uploadsDir = path.join(root, "uploads");
  mkdirSync(objectsDir, { recursive: true });
  mkdirSync(uploadsDir, { recursive: true });
  const counters = { aborted: 0, completed: 0, requests: 0 };
  /** Pending injected failures, consumed one per matching request. */
  const faults = [];
  const failNext = (op, status = 500) => { faults.push({ op, status }); };
  const operationOf = (method, q, key) => {
    if (q.has("uploadId")) return method === "PUT" ? "uploadPart" : method === "POST" ? "complete" : method === "DELETE" ? "abort" : "upload";
    if (method === "POST" && q.has("uploads")) return "create";
    if (!key) return method === "POST" && q.has("delete") ? "deleteObjects" : "bucket";
    return { PUT: "put", GET: "get", HEAD: "head", DELETE: "delete" }[method] ?? "other";
  };

  const fileFor = (bucket, key) => path.join(objectsDir, createHash("sha256").update(`${bucket}\n${key}`).digest("hex"));
  const metaOf = (bucket, key) => {
    const file = fileFor(bucket, key);
    if (!existsSync(`${file}.json`) || !existsSync(file)) return null;
    return { ...JSON.parse(readFileSync(`${file}.json`, "utf8")), file };
  };
  const allObjects = () => readdirSync(objectsDir).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(objectsDir, f), "utf8")));
  const allUploads = () => readdirSync(uploadsDir).filter((d) => existsSync(path.join(uploadsDir, d, "upload.json")))
    .map((d) => JSON.parse(readFileSync(path.join(uploadsDir, d, "upload.json"), "utf8")));

  /** Moves a fully written temp file into place with its sidecar; sha/size computed from the file. */
  async function commit(bucket, key, temp, contentType, etag) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const c of createReadStream(temp)) { hash.update(c); size += c.length; }
    const file = fileFor(bucket, key);
    renameSync(temp, file);
    const meta = { bucket, key, size, sha256: hash.digest("hex"), contentType, etag, lastModified: new Date().toISOString() };
    writeFileSync(`${file}.json`, JSON.stringify(meta));
    return meta;
  }

  async function handle(req, res) {
    counters.requests++;
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const method = req.method.toUpperCase();
    const q = url.searchParams;
    if (url.pathname === "/__fake__/fail" && method === "POST") {
      failNext(q.get("op") ?? "", Number(q.get("status") ?? 500));
      res.writeHead(204); res.end(); return;
    }
    if (url.pathname === "/__fake__/state") {
      const body = JSON.stringify({ objects: allObjects(), uploads: allUploads(), ...counters });
      res.writeHead(200, { "content-type": "application/json" }); res.end(body); return;
    }
    const segments = url.pathname.split("/").slice(1);
    const bucket = decodeURIComponent(segments[0] ?? "");
    const key = segments.slice(1).map(decodeURIComponent).join("/");
    if (!bucket) return sendError(res, 400, "InvalidBucketName", "No bucket", method);
    const fault = faults.findIndex((f) => f.op === operationOf(method, q, key));
    if (fault >= 0) {
      const { status } = faults.splice(fault, 1)[0];
      await readBody(req);
      return sendError(res, status, status === 503 ? "SlowDown" : "InternalError", "Injected failure", method);
    }
    const chunked = String(req.headers["x-amz-content-sha256"] ?? "").startsWith("STREAMING-") || /aws-chunked/.test(String(req.headers["content-encoding"] ?? ""));

    if (!key) {
      if (method === "GET" && q.get("list-type") === "2") {
        const prefix = q.get("prefix") ?? "", max = Math.max(1, Math.min(1000, Number(q.get("max-keys") ?? 1000)));
        const after = q.get("continuation-token") ? Buffer.from(q.get("continuation-token"), "base64url").toString() : q.get("start-after") ?? "";
        const keys = allObjects().filter((o) => o.bucket === bucket && o.key.startsWith(prefix) && o.key > after).sort((a, b) => (a.key < b.key ? -1 : 1));
        const page = keys.slice(0, max), truncated = keys.length > max;
        return sendXml(res, 200, `<ListBucketResult><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${
          page.map((o) => `<Contents><Key>${xmlEscape(o.key)}</Key><LastModified>${o.lastModified}</LastModified><ETag>${xmlEscape(o.etag)}</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join("")
        }${truncated ? `<NextContinuationToken>${Buffer.from(page.at(-1).key).toString("base64url")}</NextContinuationToken>` : ""}</ListBucketResult>`);
      }
      if (method === "POST" && q.has("delete")) {
        const body = (await readBody(req)).toString("utf8");
        const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => xmlUnescape(m[1]));
        for (const k of keys) { const f = fileFor(bucket, k); rmSync(f, { force: true }); rmSync(`${f}.json`, { force: true }); }
        const quiet = /<Quiet>true<\/Quiet>/.test(body);
        return sendXml(res, 200, `<DeleteResult>${quiet ? "" : keys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join("")}</DeleteResult>`);
      }
      if (method === "PUT" || method === "HEAD") { res.writeHead(200); res.end(); return; } // CreateBucket / HeadBucket
      return sendError(res, 400, "InvalidRequest", "Unsupported bucket operation", method);
    }

    const ifNoneMatch = req.headers["if-none-match"];
    const existing = () => metaOf(bucket, key);

    if (method === "POST" && q.has("uploads")) {
      const uploadId = randomUUID().replace(/-/g, "");
      mkdirSync(path.join(uploadsDir, uploadId), { recursive: true });
      writeFileSync(path.join(uploadsDir, uploadId, "upload.json"), JSON.stringify({ uploadId, bucket, key, contentType: req.headers["content-type"] ?? "application/octet-stream", started: new Date().toISOString() }));
      await readBody(req);
      return sendXml(res, 200, `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (q.has("uploadId")) {
      const uploadId = q.get("uploadId");
      const uploadDir = path.join(uploadsDir, uploadId.replace(/[^A-Za-z0-9]/g, ""));
      if (!existsSync(path.join(uploadDir, "upload.json"))) { await readBody(req); return sendError(res, 404, "NoSuchUpload", "The specified upload does not exist.", method); }
      const upload = JSON.parse(readFileSync(path.join(uploadDir, "upload.json"), "utf8"));
      if (method === "PUT") {
        const partNumber = Number(q.get("partNumber"));
        if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) { await readBody(req); return sendError(res, 400, "InvalidArgument", "Bad part number", method); }
        const temp = path.join(uploadDir, `part-${partNumber}.${randomUUID()}.tmp`);
        const hash = createHash("md5");
        if (chunked) {
          const body = decodeAwsChunked(await readBody(req));
          hash.update(body); writeFileSync(temp, body);
        } else {
          await pipeline(req, async function* (source) { for await (const c of source) { hash.update(c); yield c; } }, createWriteStream(temp));
        }
        const etag = `"${hash.digest("hex")}"`;
        renameSync(temp, path.join(uploadDir, `part-${partNumber}`));
        writeFileSync(path.join(uploadDir, `part-${partNumber}.etag`), etag);
        res.writeHead(200, { etag, "content-length": 0 }); res.end(); return;
      }
      if (method === "DELETE") {
        await readBody(req);
        rmSync(uploadDir, { recursive: true, force: true });
        counters.aborted++;
        res.writeHead(204); res.end(); return;
      }
      if (method === "POST") {
        const body = (await readBody(req)).toString("utf8");
        const parts = [...body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
          number: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1])?.[1]),
          etag: xmlUnescape(/<ETag>([\s\S]*?)<\/ETag>/.exec(m[1])?.[1] ?? ""),
        }));
        if (!parts.length) return sendError(res, 400, "MalformedXML", "No parts", method);
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (i && p.number <= parts[i - 1].number) return sendError(res, 400, "InvalidPartOrder", "Parts out of order", method);
          const etagFile = path.join(uploadDir, `part-${p.number}.etag`);
          if (!existsSync(etagFile)) return sendError(res, 400, "InvalidPart", `Part ${p.number} missing`, method);
          const want = readFileSync(etagFile, "utf8");
          if (p.etag.replace(/"/g, "") !== want.replace(/"/g, "")) return sendError(res, 400, "InvalidPart", `Part ${p.number} ETag mismatch`, method);
          if (i < parts.length - 1 && statSync(path.join(uploadDir, `part-${p.number}`)).size < 5 * 1024 * 1024)
            return sendError(res, 400, "EntityTooSmall", `Part ${p.number} is smaller than 5 MiB`, method);
        }
        if (ifNoneMatch === "*" && existing()) return sendError(res, 412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold", method);
        const temp = path.join(uploadDir, `assembled.${randomUUID()}.tmp`);
        const out = createWriteStream(temp);
        const md5s = createHash("md5");
        const partFiles = parts.map((p) => {
          md5s.update(Buffer.from(readFileSync(path.join(uploadDir, `part-${p.number}.etag`), "utf8").replace(/"/g, ""), "hex"));
          return path.join(uploadDir, `part-${p.number}`);
        });
        await pipeline(async function* () { for (const file of partFiles) yield* createReadStream(file); }, out);
        const etag = `"${md5s.digest("hex")}-${parts.length}"`;
        await commit(bucket, key, temp, upload.contentType, etag);
        rmSync(uploadDir, { recursive: true, force: true });
        counters.completed++;
        return sendXml(res, 200, `<CompleteMultipartUploadResult><Location>${xmlEscape(url.origin + url.pathname)}</Location><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`);
      }
      return sendError(res, 405, "MethodNotAllowed", "Method not allowed", method);
    }

    if (method === "PUT") {
      if (ifNoneMatch === "*" && existing()) { await readBody(req); return sendError(res, 412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold", method); }
      const temp = path.join(objectsDir, `.put.${randomUUID()}.tmp`);
      const hash = createHash("md5");
      if (chunked) {
        const body = decodeAwsChunked(await readBody(req));
        hash.update(body); writeFileSync(temp, body);
      } else {
        await pipeline(req, async function* (source) { for await (const c of source) { hash.update(c); yield c; } }, createWriteStream(temp));
      }
      const etag = `"${hash.digest("hex")}"`;
      await commit(bucket, key, temp, req.headers["content-type"] ?? "application/octet-stream", etag);
      res.writeHead(200, { etag, "content-length": 0 }); res.end(); return;
    }
    if (method === "GET" || method === "HEAD") {
      const meta = existing();
      if (!meta) return sendError(res, 404, "NoSuchKey", "The specified key does not exist.", method);
      const headers = { "content-type": meta.contentType, etag: meta.etag, "last-modified": new Date(meta.lastModified).toUTCString(), "accept-ranges": "bytes", "x-amz-meta-sha256": meta.sha256 };
      const range = method === "GET" ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "")) : null;
      if (range && meta.size > 0) {
        let startAt = range[1] === "" ? Math.max(0, meta.size - Number(range[2])) : Number(range[1]);
        let end = range[1] === "" || range[2] === "" ? meta.size - 1 : Math.min(Number(range[2]), meta.size - 1);
        if (startAt > end || startAt >= meta.size) { res.writeHead(416, { "content-range": `bytes */${meta.size}` }); res.end(); return; }
        res.writeHead(206, { ...headers, "content-length": end - startAt + 1, "content-range": `bytes ${startAt}-${end}/${meta.size}` });
        await pipeline(createReadStream(meta.file, { start: startAt, end }), res).catch(() => {});
        return;
      }
      res.writeHead(200, { ...headers, "content-length": meta.size });
      if (method === "HEAD" || meta.size === 0) { res.end(); return; }
      await pipeline(createReadStream(meta.file), res).catch(() => {});
      return;
    }
    if (method === "DELETE") {
      const f = fileFor(bucket, key);
      rmSync(f, { force: true }); rmSync(`${f}.json`, { force: true });
      res.writeHead(204); res.end(); return;
    }
    return sendError(res, 405, "MethodNotAllowed", "Method not allowed", method);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, 500, "InternalError", error?.message ?? "error");
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  const endpoint = `http://${host}:${actual}`;
  return {
    endpoint,
    port: actual,
    dir: root,
    /** Objects (metadata only), multipart uploads still open, and counters. */
    state: () => ({ objects: allObjects(), uploads: allUploads(), ...counters }),
    /** The next request of `op` answers `status` and does nothing. */
    failNext,
    /** One object's metadata ({size, sha256, etag, contentType, file}) or null. */
    object: (key, bucket) => {
      const found = allObjects().find((o) => o.key === key && (bucket == null || o.bucket === bucket));
      return found ? { ...found, file: fileFor(found.bucket, found.key) } : null;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// Not import.meta: the Playwright loader compiles this file to CommonJS when a spec imports it.
const isMain = Boolean(process.argv[1]) && path.basename(process.argv[1]) === "fake-s3-server.mjs";
if (isMain) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  // No top-level await: specs load this file with require(esm).
  start({ dir: arg("dir"), port: Number(arg("port") ?? 0), host: arg("host") ?? "127.0.0.1" }).then((s3) => {
    console.log(JSON.stringify({ endpoint: s3.endpoint, dir: s3.dir }));
    const stop = () => s3.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }, (error) => { console.error(error); process.exit(1); });
}
