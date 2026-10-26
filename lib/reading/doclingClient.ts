import { z } from "zod";
import type { WorkerOpened, WorkerPage } from "./shapes";
import type { ReadingWorker } from "./worker";

/**
 * The app's client for the Docling worker (docs/docling-worker.md; docs/reading-lane-plan.md, Step 2; SOW v2 §14, the adapters
 * lane, cited only). The worker runs on our own machine: reading costs compute, not a vendor's price, and nothing here bills.
 *
 * Two calls, both POST with the shared secret as a bearer, both JSON, both Zod-checked on the way back:
 *   /v1/open  { fileUrl, sha256, mime, bytes } → { session, pages, geometry, readerVersion }
 *   /v1/page  { session, page }                → { page, blocks }
 * The file goes to the worker as a short-lived signed URL of the workspace's own object, never as bytes through the app and
 * never as a path the worker could widen. The worker fetches it once, at open.
 *
 * Configured by `DOCLING_WORKER_URL` (one http(s) origin, no credentials, path, query or fragment) and `DOCLING_WORKER_SECRET`
 * (32 to 512 printable characters). Anything else: no worker, and the lane answers that reading is not available, with nothing
 * billed. Errors carry a code only, never the secret, the URL or the file's text.
 */

export type DoclingConfig = { readonly url: string; readonly secret: string };

const SECRET = /^[\x21-\x7e]{32,512}$/;
/** The largest answer the app takes from the worker, in bytes: a page past it fails, so a worker can never fill the app's memory. */
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** The answer's body as JSON, read up to `MAX_ANSWER_BYTES`; null when it is not JSON; a DoclingError past the cap. */
async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) throw new DoclingError("unreadable");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) { await reader.cancel().catch(() => {}); throw new DoclingError("unreadable"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

export function doclingConfig(env: Readonly<Record<string, string | undefined>> = process.env): DoclingConfig | null {
  const raw = (env.DOCLING_WORKER_URL ?? "").trim();
  const secret = (env.DOCLING_WORKER_SECRET ?? "").trim();
  if (!raw || !SECRET.test(secret)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || raw.includes("@") || url.search || url.hash || url.pathname !== "/" || !url.hostname) return null;
  return { url: url.origin, secret };
}

/**
 * Why the worker could not read: `worker_unavailable` when it could not be reached or is not serving (nothing billed),
 * `encrypted` when the file is locked, `unreadable` when the worker read it and could not make sense of it. A code only.
 */
export class DoclingError extends Error {
  constructor(readonly code: "worker_unavailable" | "encrypted" | "unreadable") { super(code); this.name = "DoclingError"; }
}

const opened = z.object({ session: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) }).passthrough();
const refusal = z.object({ error: z.enum(["encrypted", "unreadable"]) }).passthrough();

export type DoclingDeps = {
  /** The signed URL the worker fetches the upload from: the workspace's own object, short-lived. */
  fileUrl: (file: { uploadId: string; sha256: string; mime: string; bytes: number }) => Promise<string>;
  fetch?: typeof fetch;
};

/** A reader on the Docling worker: one session per file, opened once, then asked page by page. */
export function doclingWorker(config: DoclingConfig, deps: DoclingDeps): ReadingWorker {
  const send = deps.fetch ?? fetch;
  let session: string | null = null;

  const call = async (path: "/v1/open" | "/v1/page", body: unknown, signal: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await send(`${config.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
    } catch (error) {
      /* A timeout is the lane's to name (lib/reading/read.ts); anything else is the worker not being there. */
      if (signal.aborted) throw error;
      throw new DoclingError("worker_unavailable");
    }
    const json = await boundedJson(response);
    if (response.ok) return json;
    const said = refusal.safeParse(json);
    if (response.status === 422 && said.success) throw new DoclingError(said.data.error);
    const notServing = response.status >= 500 || [401, 403, 404, 408, 429].includes(response.status);
    throw new DoclingError(notServing ? "worker_unavailable" : "unreadable");
  };

  return {
    async open(file, signal): Promise<WorkerOpened> {
      /* The signed URL is ours to make: a storage that cannot make one is reading not being available, not a bad file. */
      let fileUrl: string;
      try { fileUrl = await deps.fileUrl(file); } catch { throw new DoclingError("worker_unavailable"); }
      const answer = await call("/v1/open", { fileUrl, sha256: file.sha256, mime: file.mime, bytes: file.bytes }, signal);
      const head = opened.safeParse(answer);
      if (!head.success) throw new DoclingError("unreadable");
      session = head.data.session;
      /* The lane checks the shape (workerOpened); only the three fields it reads go on. */
      const { pages, geometry, readerVersion } = (answer ?? {}) as Record<string, unknown>;
      return { pages, geometry, readerVersion } as WorkerOpened;
    },
    async page(n, signal): Promise<WorkerPage> {
      if (!session) throw new DoclingError("unreadable");
      return (await call("/v1/page", { session, page: n }, signal)) as WorkerPage;
    },
  };
}
