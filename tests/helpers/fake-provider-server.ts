import http from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for a provider's file host: serves a generated body of any size
 * without ever allocating it (a fixed cycle of 64 KiB blocks), so a
 * spec can move hundreds of MB through the store with flat memory here.
 *
 * GET /file?bytes=N            the body, Content-Length declared
 *     &declare=0              chunked, no Content-Length
 *     &stallAfter=M           send M bytes, then hold the connection open
 *     &truncateAt=M           send M bytes of the declared N, then close
 *     &gzip=1                 gzip the body whatever Accept-Encoding says, and
 *                             declare the compressed length (built in memory:
 *                             small bodies only)
 *     &hold=1                 wait for release() before sending anything
 *     &status=404             answer that status with no body
 */

const BLOCK = 64 * 1024;

/* 257 distinct blocks, built once and reused: serving a body allocates
   nothing per request, and since 257 blocks is not a whole number of 8 MiB
   parts, no two parts of a body are identical (a reordered part shows). */
const CYCLE = 257;
let blocks: Buffer[] | null = null;
function block(index: number): Buffer {
  blocks ??= Array.from({ length: CYCLE }, (_, n) => {
    const out = Buffer.alloc(BLOCK);
    let x = ((n + 1) * 2654435761) >>> 0;
    for (let i = 0; i < BLOCK; i += 4) {
      x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0;
      out.writeUInt32LE(x, i);
    }
    return out;
  });
  return blocks[index % CYCLE];
}

export function* generatedBody(bytes: number): Generator<Buffer> {
  for (let index = 0, sent = 0; sent < bytes; index++) {
    const take = Math.min(BLOCK, bytes - sent);
    const next = block(index);
    yield take === BLOCK ? next : next.subarray(0, take);
    sent += take;
  }
}

export function generatedSha256(bytes: number): string {
  const hash = createHash("sha256");
  for (const block of generatedBody(bytes)) hash.update(block);
  return hash.digest("hex");
}

export type FakeProvider = {
  url: (bytes: number, options?: { declare?: boolean; stallAfter?: number; truncateAt?: number; hold?: boolean; status?: number; gzip?: boolean }) => string;
  /** Requests received so far (including held ones). */
  readonly requests: number;
  /** The headers of the most recent request. */
  readonly lastHeaders: http.IncomingHttpHeaders;
  /** Lets every held request start sending. */
  release(): void;
  close(): Promise<void>;
};

export async function startFakeProvider(): Promise<FakeProvider> {
  let requests = 0;
  let lastHeaders: http.IncomingHttpHeaders = {};
  let releaseAll: () => void = () => {};
  let released = new Promise<void>((resolve) => { releaseAll = resolve; });
  const server = http.createServer(async (req, res) => {
    requests++;
    lastHeaders = req.headers;
    const url = new URL(req.url ?? "/", "http://provider");
    const status = Number(url.searchParams.get("status") ?? 200);
    if (status !== 200) { res.writeHead(status); res.end(); return; }
    const bytes = Number(url.searchParams.get("bytes") ?? 0);
    const declare = url.searchParams.get("declare") !== "0";
    const stallAfter = url.searchParams.has("stallAfter") ? Number(url.searchParams.get("stallAfter")) : null;
    const truncateAt = url.searchParams.has("truncateAt") ? Number(url.searchParams.get("truncateAt")) : null;
    if (url.searchParams.get("hold") === "1") await released;
    if (url.searchParams.get("gzip") === "1") {
      const zipped = gzipSync(Buffer.concat([...generatedBody(bytes)]));
      res.writeHead(200, { "content-type": "video/mp4", "content-encoding": "gzip", "content-length": String(zipped.length) });
      res.end(zipped);
      return;
    }
    res.writeHead(200, { "content-type": "video/mp4", ...(declare ? { "content-length": String(bytes) } : {}) });
    let sent = 0;
    for (const chunk of generatedBody(bytes)) {
      if (stallAfter != null && sent + chunk.length > stallAfter) {
        const head = chunk.subarray(0, Math.max(0, stallAfter - sent));
        if (head.length) res.write(head);
        return; // hold the connection open, sending nothing more
      }
      if (truncateAt != null && sent + chunk.length > truncateAt) {
        const head = chunk.subarray(0, Math.max(0, truncateAt - sent));
        res.end(head.length ? head : undefined, () => res.destroy());
        return;
      }
      sent += chunk.length;
      if (!res.write(chunk)) {
        const go = await new Promise<boolean>((resolve) => {
          const onDrain = () => { res.off("close", onClose); resolve(true); };
          const onClose = () => { res.off("drain", onDrain); resolve(false); };
          res.once("drain", onDrain);
          res.once("close", onClose);
        });
        if (!go) return;
      }
      if (res.destroyed) return;
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (bytes, options = {}) => {
      const q = new URLSearchParams({ bytes: String(bytes) });
      if (options.declare === false) q.set("declare", "0");
      if (options.stallAfter != null) q.set("stallAfter", String(options.stallAfter));
      if (options.truncateAt != null) q.set("truncateAt", String(options.truncateAt));
      if (options.hold) q.set("hold", "1");
      if (options.gzip) q.set("gzip", "1");
      if (options.status) q.set("status", String(options.status));
      return `http://127.0.0.1:${port}/file?${q}`;
    },
    get requests() { return requests; },
    get lastHeaders() { return lastHeaders; },
    release() { releaseAll(); released = Promise.resolve(); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
