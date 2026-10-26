import { test, expect } from "@playwright/test";
import { doclingConfig, DoclingError, doclingWorker, type DoclingConfig } from "../../lib/reading/doclingClient";

/*
 * The app's client for the Docling worker (lib/reading/doclingClient.ts; docs/docling-worker.md): configured only by an origin
 * and a secret, two JSON calls with the secret as a bearer, the file as a signed URL, every failure a code that never carries the
 * secret, the URL or the file's text. A stand-in for fetch; no network.
 */

const SECRET = "s".repeat(40);
const CONFIG: DoclingConfig = { url: "http://docling.internal:8080", secret: SECRET };
const FILE = { uploadId: "up_pdf", sha256: "a".repeat(64), mime: "application/pdf", bytes: 1000 };
const SIGNED = "https://storage.example/ws_a/uploads/up_pdf.pdf?signature=abc";

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error("unexpected call");
    return next(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OPENED = { session: "sess_0123456789", pages: 2, geometry: "page", readerVersion: "docling-test" };
const PAGE = (n: number) => ({ page: n, blocks: [{ kind: "paragraph", x0: 0, y0: 0, x1: 1, y1: 1, text: `Page ${n}.`, confidence: 0.9 }] });
const signal = () => new AbortController().signal;

test("configured only by one origin and a long enough secret", () => {
  expect(doclingConfig({ DOCLING_WORKER_URL: "http://docling.internal:8080", DOCLING_WORKER_SECRET: SECRET })).toEqual(CONFIG);
  expect(doclingConfig({ DOCLING_WORKER_URL: "https://docling.example/", DOCLING_WORKER_SECRET: SECRET })).toEqual({ url: "https://docling.example", secret: SECRET });
  for (const env of [
    {}, { DOCLING_WORKER_URL: "http://docling.internal:8080" }, { DOCLING_WORKER_SECRET: SECRET },
    { DOCLING_WORKER_URL: "http://docling.internal:8080", DOCLING_WORKER_SECRET: "short" },
    { DOCLING_WORKER_URL: "http://docling.internal:8080", DOCLING_WORKER_SECRET: "with space ".repeat(5) },
    { DOCLING_WORKER_URL: "ftp://docling.internal", DOCLING_WORKER_SECRET: SECRET },
    { DOCLING_WORKER_URL: "http://user:pass@docling.internal", DOCLING_WORKER_SECRET: SECRET },
    { DOCLING_WORKER_URL: "http://docling.internal/v1", DOCLING_WORKER_SECRET: SECRET },
    { DOCLING_WORKER_URL: "http://docling.internal/?x=1", DOCLING_WORKER_SECRET: SECRET },
    { DOCLING_WORKER_URL: "not a url", DOCLING_WORKER_SECRET: SECRET },
  ]) expect(doclingConfig(env), JSON.stringify(env)).toBeNull();
});

test("open then page by page: the secret as a bearer, the file as a signed URL, one session", async () => {
  const fake = fakeFetch([() => json(OPENED), () => json(PAGE(1)), () => json(PAGE(2))]);
  const urls: unknown[] = [];
  const worker = doclingWorker(CONFIG, { fileUrl: async (file) => { urls.push(file); return SIGNED; }, fetch: fake.fn });
  const s = signal();
  expect(await worker.open(FILE, s)).toEqual({ pages: 2, geometry: "page", readerVersion: "docling-test" });
  expect(await worker.page(1, s)).toEqual(PAGE(1));
  expect(await worker.page(2, s)).toEqual(PAGE(2));
  expect(urls).toEqual([FILE]);
  expect(fake.calls.map((c) => c.url)).toEqual([`${CONFIG.url}/v1/open`, `${CONFIG.url}/v1/page`, `${CONFIG.url}/v1/page`]);
  for (const call of fake.calls) {
    expect(call.init).toMatchObject({ method: "POST", redirect: "error", signal: s });
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
  }
  expect(JSON.parse(String(fake.calls[0].init.body))).toEqual({ fileUrl: SIGNED, sha256: FILE.sha256, mime: FILE.mime, bytes: FILE.bytes });
  expect(JSON.parse(String(fake.calls[1].init.body))).toEqual({ session: OPENED.session, page: 1 });
});

test("every failure is a code: not there, not serving, locked, unreadable; never the secret, the URL or the text", async () => {
  const fail = async (answer: (call: Call) => Response | Promise<Response>) => {
    const worker = doclingWorker(CONFIG, { fileUrl: async () => SIGNED, fetch: fakeFetch([answer]).fn });
    return worker.open(FILE, signal()).then(() => null, (error: unknown) => error);
  };
  const cases: [string, (call: Call) => Response | Promise<Response>, string][] = [
    ["unreachable", () => { throw new TypeError(`fetch failed ${CONFIG.url} ${SECRET}`); }, "worker_unavailable"],
    ["a server error", () => json({ error: SECRET }, 500), "worker_unavailable"],
    ["a wrong secret", () => json({}, 401), "worker_unavailable"],
    ["no such route", () => new Response("not found", { status: 404 }), "worker_unavailable"],
    ["a locked file", () => json({ error: "encrypted" }, 422), "encrypted"],
    ["a file it could not read", () => json({ error: "unreadable" }, 422), "unreadable"],
    ["a bad request", () => json({ error: "bad" }, 400), "unreadable"],
    ["an answer with no session", () => json({ pages: 2, geometry: "page", readerVersion: "x" }), "unreadable"],
    ["an answer that is not JSON", () => new Response("<html>", { status: 200 }), "unreadable"],
  ];
  for (const [what, answer, code] of cases) {
    const error = await fail(answer);
    expect(error, what).toBeInstanceOf(DoclingError);
    expect((error as DoclingError).code, what).toBe(code);
    expect(String((error as Error).message), what).not.toContain(SECRET);
    expect(String((error as Error).message), what).not.toContain("docling.internal");
  }
});

test("a page before the file is open is refused; a timeout is left for the lane to name", async () => {
  const worker = doclingWorker(CONFIG, { fileUrl: async () => SIGNED, fetch: fakeFetch([]).fn });
  await expect(worker.page(1, signal())).rejects.toMatchObject({ code: "unreadable" });
  const stop = new AbortController();
  const timeout = new DOMException("timeout", "TimeoutError");
  const slow = doclingWorker(CONFIG, { fileUrl: async () => SIGNED, fetch: fakeFetch([() => { stop.abort(); throw timeout; }]).fn });
  await expect(slow.open(FILE, stop.signal)).rejects.toBe(timeout);
});
