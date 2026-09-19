import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import type { WorkerEvent } from "../../lib/dispatch";

/**
 * The native worker route, loaded with the transpile-and-inject seam so its
 * collaborators (fence, slots, handler) are fakes and no database is opened.
 */

function load<T>(file: string, dependencies: Record<string, unknown>, env: Record<string, string | undefined>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", "process", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports, { env },
  );
  return mod.exports as T;
}

type Route = { POST: (req: Request) => Promise<Response> };

async function fixture(options: {
  fence?: "open" | "draining" | "closed";
  slot?: boolean;
  reserveThrows?: boolean;
  handlerThrows?: boolean;
  secret?: string | null;
  nodeEnv?: string;
} = {}) {
  const dispatch = await import("../../lib/dispatch");
  const handled: WorkerEvent[] = [], continuations: (() => Promise<void>)[] = [];
  const slots: { acquired: unknown[]; released: string[]; chained: unknown[] } = { acquired: [], released: [], chained: [] };
  const logs: string[] = [];
  const dependencies = {
    "next/server": {
      NextResponse: Response,
      after: (fn: () => Promise<void>) => { continuations.push(fn); },
    },
    "@/lib/dispatch": dispatch,
    "@/lib/worker-handlers": {
      workerJobId: (event: WorkerEvent) => event.data.genId ?? event.data.jobId ?? event.data.probeId ?? "",
      runWorkerHandler: async (event: WorkerEvent) => {
        handled.push(event);
        if (options.handlerThrows) throw new Error("SECRET provider failure https://vendor.example/?token=SECRET");
        return { ok: true };
      },
    },
    "@/lib/worker-slots": {
      acquireSlot: async (input: unknown) => { slots.acquired.push(input); return options.slot === false ? null : { id: "slot-1" }; },
      releaseSlot: async (id: string) => { slots.released.push(id); },
      chainDispatch: async (input: unknown) => { slots.chained.push(input); return false; },
    },
    "@/lib/recovery": {
      recoveryFence: () => ({ status: async () => ({ state: options.fence ?? "open" }) }),
      reserveRecoveryContinuation: async (_kind: string, run: () => Promise<void>) => {
        if (options.reserveThrows) throw new Error("RECOVERY_FENCED");
        return async () => run();
      },
      withRecoveryJob: async (_ws: string, _id: string, run: () => Promise<unknown>) => run(),
    },
  };
  const secret = options.secret === undefined ? "fixture-cron-secret" : options.secret;
  const route = load<Route>("app/api/worker/route.ts", dependencies, {
    NODE_ENV: options.nodeEnv ?? "production",
    ...(secret ? { CRON_SECRET: secret } : {}),
  });
  const original = { info: console.info, error: console.error };
  const post = async (body: unknown, auth: string | null = secret ? `Bearer ${secret}` : null) => {
    console.info = (line: string) => { logs.push(String(line)); };
    console.error = (line: string) => { logs.push(String(line)); };
    try {
      const response = await route.POST(new Request("https://app.example.test/api/worker", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }));
      for (const fn of continuations.splice(0)) await fn();
      return response;
    } finally {
      console.info = original.info;
      console.error = original.error;
    }
  };
  return { post, handled, slots, logs };
}

const event: WorkerEvent = { id: "render-ws_1-gen_1", name: "render/requested", data: { genId: "gen_1", kind: "image", workspaceId: "ws_1" } };

test("worker route refuses a missing or wrong bearer in production and accepts none outside it only when no secret is set", async () => {
  const f = await fixture();
  expect((await f.post(event, null)).status).toBe(401);
  expect((await f.post(event, "Bearer wrong")).status).toBe(401);
  expect(f.handled).toHaveLength(0);
  const open = await fixture({ secret: null, nodeEnv: "development" });
  expect((await open.post(event, null)).status).toBe(202);
  const locked = await fixture({ secret: null, nodeEnv: "production" });
  expect((await locked.post(event, null)).status).toBe(401);
});

test("worker route rejects malformed events before touching the fence or a slot", async () => {
  const f = await fixture();
  for (const body of [
    "not json",
    { id: "x", name: "render/requested" },
    { id: "x", name: "unknown/event", data: { genId: "gen_1" } },
    { id: "x", name: "render/requested", data: { genId: "gen 1 with spaces", workspaceId: "ws" } },
    { id: "x", name: "render/requested", data: { genId: "https://evil.example/", workspaceId: "ws" } },
    { id: "x", name: "render/requested", data: { genId: "gen_1", workspaceId: "ws", extra: { nested: true } } },
    { id: "x", name: "render/requested", data: { workspaceId: "ws_1" } },
    { id: "x", name: "render/requested", data: { genId: "gen_1" }, unexpected: 1 },
  ])
    expect((await f.post(body)).status).toBe(400);
  expect(f.slots.acquired).toHaveLength(0);
  expect(f.handled).toHaveLength(0);
});

test("a closed or draining fence answers 503 maintenance and starts nothing", async () => {
  for (const fence of ["closed", "draining"] as const) {
    const f = await fixture({ fence });
    const response = await f.post(event);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ maintenance: true });
    expect(f.slots.acquired).toHaveLength(0);
    expect(f.handled).toHaveLength(0);
  }
  const raced = await fixture({ reserveThrows: true });
  expect((await raced.post(event)).status).toBe(503);
  expect(raced.slots.released).toEqual(["slot-1"]);
  expect(raced.handled).toHaveLength(0);
});

test("an accepted event answers 202 first, then runs the handler once under its slot and logs a fixed-shape line", async () => {
  const f = await fixture();
  const response = await f.post(event);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  expect(f.handled).toEqual([event]);
  expect(f.slots.acquired).toEqual([{ kind: "render/requested", workspaceId: "ws_1", jobId: "gen_1" }]);
  expect(f.slots.released).toEqual(["slot-1"]);
  expect(f.slots.chained).toEqual([{ kind: "render/requested", workspaceId: "ws_1" }]);
  const line = JSON.parse(f.logs.find((l) => l.includes("worker.finished"))!);
  expect(line).toMatchObject({ event: "worker.finished", name: "render/requested", ok: true });
  expect(typeof line.durationMs).toBe("number");
  expect(Object.keys(line).sort()).toEqual(["durationMs", "event", "level", "name", "ok"]);

  const failing = await fixture({ handlerThrows: true });
  expect((await failing.post(event)).status).toBe(202);
  const failed = failing.logs.find((l) => l.includes("worker.finished"))!;
  expect(JSON.parse(failed)).toMatchObject({ ok: false, name: "render/requested" });
  expect(failed).not.toContain("SECRET");
  expect(failing.slots.released).toEqual(["slot-1"]);
});

test("a refused slot answers 202 accepted:false busy and does not run the handler", async () => {
  const f = await fixture({ slot: false });
  const response = await f.post(event);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: false, reason: "busy" });
  expect(f.handled).toHaveLength(0);
  expect(f.slots.released).toHaveLength(0);
  expect(f.logs.find((l) => l.includes("worker.finished"))).toBeUndefined();
});
