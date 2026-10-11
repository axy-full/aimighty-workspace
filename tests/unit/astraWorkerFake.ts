/* An in-memory pool of self-hosted render workers speaking the worker protocol
   (lib/astra-blender/selfhost-sdk.ts), behind a stubbed fetch. No network. */
export const WORKER_SECRET = "unit-worker-secret-0123456789-abcdefghij";
export const WORKER_URLS = ["http://render-1:8790", "http://render-2:8790", "http://render-3:8790"];

export type WorkerMode = "free" | "busy" | "down" | "refuse" | "error";
type Session = { name: string; status: "running" | "stopped"; files: Map<string, Buffer>; createdAt?: number; stoppedAt?: number };
export type WorkerCall = { origin: string; method: string; path: string; query: string | null; redirect: RequestRedirect | undefined; authorization: string | null; body: Buffer | null };

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDpkAAAAASUVORK5CYII=", "base64");

/** `secrets` gives a worker its own secret; the rest expect WORKER_SECRET. */
export function workerPool(origins: string[] = WORKER_URLS, secrets: Record<string, string> = {}) {
  const modes = new Map<string, WorkerMode>(origins.map((origin) => [origin, "free"]));
  const sessions = new Map<string, Session>();
  const calls: WorkerCall[] = [];
  const usage = { activeCpuMs: 12000, durationMs: 15000, egressBytes: 0 };
  let exitCode = 0, liveDuration = false;
  /* By default a fixed usage; with liveDuration, wall time from create to stop, frozen at stop (as the worker reports it). */
  const reported = (held: Session) => liveDuration ? { ...usage, durationMs: (held.stoppedAt ?? Date.now()) - (held.createdAt ?? Date.now()) } : usage;
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: URL, init: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = init.body == null ? null : Buffer.from(typeof init.body === "string" ? init.body : (init.body as Uint8Array));
    calls.push({ origin: url.origin, method: init.method ?? "GET", path: url.pathname, query: url.searchParams.get("path"), redirect: init.redirect, authorization: headers.get("authorization"), body });
    const mode = modes.get(url.origin);
    if (!mode) throw new TypeError(`fetch failed: ENOTFOUND ${url.host}`);
    if (mode === "down") throw new TypeError(`fetch failed: ECONNREFUSED ${url.host} ${headers.get("authorization")}`);
    if (headers.get("authorization") !== `Bearer ${secrets[url.origin] ?? WORKER_SECRET}`) return reply(401, { error: "unauthorized" });
    if (mode === "refuse") return reply(403, { error: "forbidden" });
    if (mode === "error") return reply(500, { error: "worker error" });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "v1" || parts[1] !== "sessions") return reply(404);
    const held = sessions.get(url.origin);
    if (parts.length === 2 && init.method === "POST") {
      const { name } = JSON.parse(body!.toString());
      if (!/^astra-blender-[0-9a-f-]{36}$/.test(String(name))) return reply(400, { error: "bad name" });
      // A running session makes the worker busy; a stopped one is replaced.
      if (mode === "busy" || held?.status === "running") return reply(409, { busy: true });
      sessions.set(url.origin, { name, status: "running", files: new Map(), createdAt: Date.now() });
      return reply(201, { name, status: "running" });
    }
    const name = parts[2];
    if (!held || held.name !== name) return reply(404);
    if (parts.length === 3 && init.method === "GET") return reply(200, { name, status: held.status, ...reported(held) });
    if (parts.length === 3 && init.method === "DELETE") { if (held.status === "running") held.stoppedAt = Date.now(); held.status = "stopped"; held.files.clear(); return reply(200, { name, status: "stopped", ...reported(held) }); }
    if (held.status === "stopped" && init.method !== "GET") return reply(409, { error: "stopped" });
    if (parts[3] === "files" && init.method === "PUT") { held.files.set(url.searchParams.get("path")!, body!); return reply(201, { path: url.searchParams.get("path"), bytes: body!.length }); }
    if (parts[3] === "run" && init.method === "POST") {
      const run = JSON.parse(body!.toString());
      if (Object.keys(run).sort().join() !== "args,cmd,cwd,timeoutMs" || run.cmd !== "/usr/bin/python3" || JSON.stringify(run.args) !== '["run.py"]' || run.cwd !== "/vercel/sandbox/astra" || !Number.isInteger(run.timeoutMs) || run.timeoutMs < 1 || run.timeoutMs > 180000) return reply(400, { error: "bad run" });
      const output = "/vercel/sandbox/astra/output/";
      held.files.set(`${output}scene.blend`, Buffer.from("BLENDER-v502test"));
      held.files.set(`${output}preview.png`, png);
      return reply(200, { exitCode, stdout: "Blender quit", stderr: "", timedOut: false });
    }
    if (parts[3] === "files" && init.method === "GET") {
      const file = held.files.get(url.searchParams.get("path")!);
      return file ? new Response(new Uint8Array(file), { status: 200 }) : reply(404);
    }
    return reply(404);
  };
  return {
    fetch, calls, sessions, usage, modes,
    /** Workers holding a session that is still running. */
    running: () => [...sessions].filter(([, session]) => session.status === "running").map(([origin]) => origin),
    set(origin: string, mode: WorkerMode) { modes.set(origin, mode); },
    set exitCode(value: number) { exitCode = value; },
    set liveDuration(value: boolean) { liveDuration = value; },
    /** Leave a session on a worker as if another render held it. */
    hold(origin: string, name: string) { sessions.set(origin, { name, status: "running", files: new Map() }); },
  };
}
