/* An in-memory export worker speaking the protocol of ops/remotion-worker/README.md (lib/exports/worker.ts), behind a
   stubbed fetch. No network, no render, no Docker, no engine. The mock of the export tool. */
export const EXPORT_WORKER_SECRET = "unit-export-secret-0123456789-abcdefghij";
export const EXPORT_WORKER_URLS = ["http://remotion-1:8790"];

type Session = { name: string; status: "running" | "stopped"; files: Map<string, Buffer>; stopped?: () => void };
export type FakeCall = { origin: string; method: string; path: string; query: string | null; redirect: RequestRedirect | undefined; authorization: string | null; body: Buffer | null };

export type RunBehaviour = {
  /** What the export command exits with. */
  exitCode?: number;
  timedOut?: boolean;
  /** What result.json says (a failed run's reasons). */
  result?: { ok: boolean; code?: string; errors?: string[] };
  /** The bytes of export.mp4 on a successful run; none leaves the file missing. */
  mp4?: Buffer | null;
  /** Runs inside the run call, before it answers. A promise that does not settle holds the run until the session is deleted. */
  during?: (session: { name: string; spec: Record<string, unknown> | null; files: string[] }) => Promise<void> | void;
  /** Runs when an output is read. */
  onRead?: (path: string) => Promise<void> | void;
};

const mp4 = () => Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(64, 7)]);

/** `secrets` gives a worker its own secret; the rest expect EXPORT_WORKER_SECRET. */
export function exportWorkerPool(origins: string[] = EXPORT_WORKER_URLS, secrets: Record<string, string> = {}) {
  const modes = new Map<string, "free" | "busy" | "down" | "refuse" | "error">(origins.map((origin) => [origin, "free"]));
  const sessions = new Map<string, Session>();
  const calls: FakeCall[] = [];
  let behaviour: RunBehaviour = {};
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch = async (input: URL, init: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = init.body == null ? null : Buffer.from(typeof init.body === "string" ? init.body : (init.body as Uint8Array));
    calls.push({ origin: url.origin, method: init.method ?? "GET", path: url.pathname, query: url.searchParams.get("path"), redirect: init.redirect, authorization: headers.get("authorization"), body });
    const mode = modes.get(url.origin);
    if (!mode) throw new TypeError(`fetch failed: ENOTFOUND ${url.host}`);
    if (mode === "down") throw new TypeError(`fetch failed: ECONNREFUSED ${url.host} ${headers.get("authorization")}`);
    if (headers.get("authorization") !== `Bearer ${secrets[url.origin] ?? EXPORT_WORKER_SECRET}`) return reply(401, { error: "unauthorized" });
    if (mode === "refuse") return reply(403, { error: "forbidden" });
    if (mode === "error") return reply(500, { error: "worker error" });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "v1" || parts[1] !== "sessions") return reply(404);
    const held = sessions.get(url.origin);
    if (parts.length === 2 && init.method === "POST") {
      const { name } = JSON.parse(body!.toString());
      if (!/^remotion-export-[0-9a-f-]{36}$/.test(String(name))) return reply(400, { error: "bad name" });
      if (mode === "busy" || held?.status === "running") return reply(409, { busy: true });
      sessions.set(url.origin, { name, status: "running", files: new Map() });
      return reply(201, { name, status: "running" });
    }
    const name = parts[2];
    if (!held || held.name !== name) return reply(404);
    if (parts.length === 3 && init.method === "DELETE") {
      held.status = "stopped";
      held.files.clear();
      held.stopped?.();
      return reply(200, { name, status: "stopped", activeCpuMs: 1000, durationMs: 2000, egressBytes: 0 });
    }
    if (held.status === "stopped") return reply(409, { error: "stopped" });
    const root = "/vercel/sandbox/remotion/";
    if (parts[3] === "files" && init.method === "PUT") {
      const path = url.searchParams.get("path")!;
      if (!path.startsWith(root) || path.includes("..")) return reply(400, { error: "path_refused" });
      held.files.set(path.slice(root.length), body!);
      return reply(201, { path, bytes: body!.length });
    }
    if (parts[3] === "run" && init.method === "POST") {
      const run = JSON.parse(body!.toString());
      if (Object.keys(run).sort().join() !== "args,cmd,cwd,timeoutMs" || run.cmd !== "/usr/local/bin/node" || JSON.stringify(run.args) !== '["/opt/remotion/cli.mjs"]' || run.cwd !== "/vercel/sandbox/remotion" || !Number.isInteger(run.timeoutMs) || run.timeoutMs < 1 || run.timeoutMs > 900000) return reply(400, { error: "command_refused" });
      let spec: Record<string, unknown> | null = null;
      try { spec = JSON.parse(held.files.get("spec.json")!.toString()); } catch { /* no spec */ }
      if (behaviour.during) {
        const released = new Promise<"released">((resolve) => { held.stopped = () => resolve("released"); });
        const finished = Promise.resolve(behaviour.during({ name, spec, files: [...held.files.keys()] })).then(() => "done" as const);
        if ((await Promise.race([finished, released])) === "released") return reply(200, { exitCode: 137, stdout: "", stderr: "", timedOut: false });
      }
      const exitCode = behaviour.exitCode ?? 0;
      if (exitCode === 0) {
        if (behaviour.mp4 !== null) held.files.set("output/export.mp4", behaviour.mp4 ?? mp4());
        held.files.set("output/result.json", Buffer.from(JSON.stringify({ ok: true })));
      } else if (behaviour.result) held.files.set("output/result.json", Buffer.from(JSON.stringify(behaviour.result)));
      return reply(200, { exitCode, stdout: "done", stderr: "", timedOut: behaviour.timedOut === true });
    }
    if (parts[3] === "files" && init.method === "GET") {
      const path = url.searchParams.get("path")!;
      await behaviour.onRead?.(path);
      const file = held.files.get(path.startsWith(root) ? path.slice(root.length) : path);
      return file ? new Response(new Uint8Array(file), { status: 200 }) : reply(404);
    }
    return reply(404);
  };

  return {
    fetch,
    calls,
    sessions,
    config: { urls: origins, secrets: origins.map((origin) => secrets[origin] ?? EXPORT_WORKER_SECRET) },
    set(origin: string, mode: "free" | "busy" | "down" | "refuse" | "error") { modes.set(origin, mode); },
    behave(next: RunBehaviour) { behaviour = next; },
    running: () => [...sessions].filter(([, session]) => session.status === "running").map(([origin]) => origin),
    /** The files uploaded to the current session, by relative path. */
    uploaded: (origin = origins[0]) => [...(sessions.get(origin)?.files.keys() ?? [])],
  };
}
