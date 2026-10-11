import { test, expect } from "@playwright/test";
import { Readable } from "node:stream";
import { astraRenderBackend, astraSelfhostConfig, ASTRA_COMPUTE_ENGINES, isAstraComputeEngine, astraBackendOfEngine } from "../../lib/astra-blender/backend";
import { createSelfhostSdk, astraWorkerUrl, forgetAstraWorkerSessions, AstraWorkerBusyError, AstraWorkerRefusedError, AstraWorkerSessionMissingError, AstraWorkerError, ASTRA_WORKER_RUN_TIMEOUT_MS, ASTRA_WORKER_CALL_TIMEOUT_MS } from "../../lib/astra-blender/selfhost-sdk";
import { astraRuntimeStatus } from "../../lib/astra-blender/sandbox";
import { workerPool, WORKER_SECRET, WORKER_URLS } from "./astraWorkerFake";

/* The self-hosted render worker client, against an in-memory worker pool behind
   a stubbed fetch. Nothing here reaches a network or starts a render. */

const NAME = "astra-blender-00000000-0000-4000-8000-000000000001";
const config = { urls: WORKER_URLS, secrets: WORKER_URLS.map(() => WORKER_SECRET) };
const [W1, W2, W3] = WORKER_URLS;
const sdkWith = (pool: ReturnType<typeof workerPool>, over: Partial<typeof config> = {}) => createSelfhostSdk({ config: { ...config, ...over }, fetch: pool.fetch });
const create = (sdk: ReturnType<typeof createSelfhostSdk>, name = NAME) => sdk.create({ name } as Parameters<typeof sdk.create>[0]);

test.beforeEach(() => forgetAstraWorkerSessions());

const RUNTIME_KEYS = ["ASTRA_RENDER_BACKEND", "ASTRA_WORKER_URLS", "ASTRA_WORKER_SECRET", "ASTRA_WORKER_SECRETS", "ASTRA_BLENDER_SNAPSHOT_ID", "VERCEL", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"];
function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.fromEntries(RUNTIME_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of RUNTIME_KEYS) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
    return run();
  } finally {
    for (const key of RUNTIME_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

test("the render backend switch defaults to Vercel; selfhost is configured by its workers and secret alone", () => {
  expect(astraRenderBackend({})).toBe("vercel");
  expect(astraRenderBackend({ ASTRA_RENDER_BACKEND: "" })).toBe("vercel");
  expect(astraRenderBackend({ ASTRA_RENDER_BACKEND: "vercel" })).toBe("vercel");
  expect(astraRenderBackend({ ASTRA_RENDER_BACKEND: " SelfHost " })).toBe("selfhost");
  expect(astraRenderBackend({ ASTRA_RENDER_BACKEND: "selfhosted" })).toBeNull();
  // Unset: the Vercel path, which still wants its snapshot.
  const vercel = withEnv({}, () => astraRuntimeStatus());
  expect(vercel.configured).toBe(false);
  expect(vercel.reason).toContain("snapshot");
  // An unrecognised setting is not connected, never silently some backend.
  expect(withEnv({ ASTRA_RENDER_BACKEND: "elsewhere", ASTRA_BLENDER_SNAPSHOT_ID: "snap_verified-test", VERCEL: "1" }, () => astraRuntimeStatus().configured)).toBe(false);
  // Selfhost: configured with no snapshot and no Vercel credentials, and none of them is read.
  const reads = new Set<string>();
  const original = process.env;
  const status = withEnv({ ASTRA_RENDER_BACKEND: "selfhost", ASTRA_WORKER_URLS: WORKER_URLS.join(","), ASTRA_WORKER_SECRET: WORKER_SECRET }, () => {
    process.env = new Proxy(original, { get: (target, key) => { if (typeof key === "string") reads.add(key); return Reflect.get(target, key); } });
    try { return astraRuntimeStatus(); } finally { process.env = original; }
  });
  expect(status).toMatchObject({ configured: true, reason: null, blenderVersion: "5.2.2", timeoutMs: 180000 });
  expect([...reads].filter((key) => key.startsWith("VERCEL") || key === "ASTRA_BLENDER_SNAPSHOT_ID")).toEqual([]);
  // Selfhost without its secret is not connected, even with every Vercel setting present.
  const missing = withEnv({ ASTRA_RENDER_BACKEND: "selfhost", ASTRA_WORKER_URLS: W1, ASTRA_BLENDER_SNAPSHOT_ID: "snap_verified-test", VERCEL: "1" }, () => astraRuntimeStatus());
  expect(missing.configured).toBe(false);
  expect(missing.reason).toContain("render workers");
  // Engine labels: a row from before the switch has none and is Vercel's.
  expect(ASTRA_COMPUTE_ENGINES).toEqual({ vercel: "vercel-sandbox", selfhost: "selfhost-blender" });
  expect([isAstraComputeEngine("selfhost-blender"), isAstraComputeEngine("vercel-sandbox"), isAstraComputeEngine("byteplus")]).toEqual([true, true, false]);
  expect([astraBackendOfEngine(undefined), astraBackendOfEngine("vercel-sandbox"), astraBackendOfEngine("selfhost-blender")]).toEqual(["vercel", "vercel", "selfhost"]);
});

test("selfhost configuration takes one to three plain http(s) worker origins and a secret of at least 32 characters", () => {
  const ok = (urls: string, secret = WORKER_SECRET) => astraSelfhostConfig({ ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRET: secret });
  expect(ok("http://render-1:8080")).toEqual({ urls: ["http://render-1:8080"], secrets: [WORKER_SECRET] });
  expect(ok(" http://render-1:8080/ , https://render-2.internal ,http://10.0.0.3:9000")?.urls).toEqual(["http://render-1:8080", "https://render-2.internal", "http://10.0.0.3:9000"]);
  for (const urls of [
    "", " , ", "http://a:1,http://b:1,http://c:1,http://d:1", "ftp://render-1:21", "render-1:8080", "http://user:pass@render-1:8080",
    "http://token@render-1:8080", "http://render-1:8080/v1", "http://render-1:8080/?x=1", "http://render-1:8080/#frag", "http://render-1:8080,http://render-1:8080",
    "javascript:alert(1)", "file:///etc/passwd",
  ]) expect(ok(urls), urls).toBeNull();
  expect(ok(W1, "x".repeat(31))).toBeNull();
  expect(ok(W1, `${"x".repeat(31)} `)).toBeNull();
  expect(ok(W1, `${"x".repeat(40)}\n`)).toBeNull();
  expect(ok(W1, "x".repeat(32))).not.toBeNull();
  expect(astraSelfhostConfig({ ASTRA_WORKER_URLS: W1 })).toBeNull();
});

test("create tries the workers in order, skips busy ones and takes the first 201", async () => {
  const pool = workerPool();
  pool.set(W1, "busy");
  const handle = await create(sdkWith(pool));
  expect(handle).toMatchObject({ name: NAME, status: "running" });
  expect(pool.calls.map((call) => `${call.method} ${call.origin}${call.path}`)).toEqual([`POST ${W1}/v1/sessions`, `POST ${W2}/v1/sessions`]);
  expect(JSON.parse(pool.calls[1].body!.toString())).toEqual({ name: NAME });
  expect(pool.sessions.get(W2)?.name).toBe(NAME);
  expect(pool.calls.every((call) => call.redirect === "error" && call.authorization === `Bearer ${WORKER_SECRET}`)).toBe(true);
  // Busy workers are never sent a stop: their sessions are someone else's.
  pool.hold(W3, "astra-blender-00000000-0000-4000-8000-0000000000ff");
  pool.calls.length = 0;
  await expect(create(sdkWith(pool), "astra-blender-00000000-0000-4000-8000-000000000002")).rejects.toBeInstanceOf(AstraWorkerBusyError);
  expect(pool.calls.map((call) => call.method)).toEqual(["POST", "POST", "POST"]);
});

test("every worker busy throws the typed busy error before anything started", async () => {
  const pool = workerPool();
  for (const origin of WORKER_URLS) pool.set(origin, "busy");
  const error = await create(sdkWith(pool)).catch((e) => e);
  expect(error).toBeInstanceOf(AstraWorkerBusyError);
  expect(error.notStarted).toBe(true);
  expect(pool.sessions.size).toBe(0);
  expect(pool.calls.map((call) => `${call.method} ${call.origin}`)).toEqual(WORKER_URLS.map((origin) => `POST ${origin}`));
});

test("a lost create reply is cleared on that worker before the next is tried; an unclearable one stops the attempt", async () => {
  // The reply to worker 1 is lost, but its stop confirms nothing is held there: worker 2 takes it.
  const pool = workerPool();
  let lost = false;
  const flaky = async (input: URL, init: RequestInit) => {
    if (!lost && init.method === "POST" && new URL(String(input)).origin === W1) { lost = true; await pool.fetch(input, init); throw new TypeError("socket hang up"); }
    return pool.fetch(input, init);
  };
  const handle = await createSelfhostSdk({ config, fetch: flaky }).create({ name: NAME } as never);
  expect(pool.calls.map((call) => `${call.method} ${call.origin}`)).toEqual([`POST ${W1}`, `DELETE ${W1}`, `POST ${W2}`]);
  expect(pool.running()).toEqual([W2]);
  expect(pool.sessions.get(W1)?.status).toBe("stopped");
  expect(handle.name).toBe(NAME);
  // Worker 1 unreachable even for the stop: it may hold the render, so no other worker is tried.
  const down = workerPool();
  down.set(W1, "down");
  const error = await create(sdkWith(down)).catch((e) => e);
  expect(error).toBeInstanceOf(AstraWorkerError);
  expect(error).not.toBeInstanceOf(AstraWorkerBusyError);
  expect(down.calls.map((call) => `${call.method} ${call.origin}`)).toEqual([`POST ${W1}`, `DELETE ${W1}`]);
  // A worker error whose stop is confirmed counts as unavailable: with the rest busy, that is busy.
  const mixed = workerPool();
  mixed.set(W2, "busy"); mixed.set(W3, "busy");
  let failedOnce = false;
  const erroring = async (input: URL, init: RequestInit) => {
    if (!failedOnce && init.method === "POST" && new URL(String(input)).origin === W1) { failedOnce = true; return new Response(null, { status: 503 }); }
    return mixed.fetch(input, init);
  };
  await expect(createSelfhostSdk({ config, fetch: erroring }).create({ name: NAME } as never)).rejects.toBeInstanceOf(AstraWorkerBusyError);
});

test("workers that refuse outright (a wrong secret) throw the typed refusal, not busy", async () => {
  const pool = workerPool();
  const error = await create(sdkWith(pool, { secrets: WORKER_URLS.map(() => "a-different-secret-that-is-long-enough-0") })).catch((e) => e);
  expect(error).toBeInstanceOf(AstraWorkerRefusedError);
  expect(error.notStarted).toBe(true);
  // A refusal beside busy workers is still busy: try again later.
  pool.set(W1, "refuse"); pool.set(W2, "busy"); pool.set(W3, "busy");
  await expect(create(sdkWith(pool))).rejects.toBeInstanceOf(AstraWorkerBusyError);
});

test("the handle maps files, the fixed launcher, outputs and stop onto the session API, and keeps the final usage", async () => {
  const pool = workerPool();
  const sdk = sdkWith(pool);
  const handle = await create(sdk);
  await handle.writeFiles([{ path: "/vercel/sandbox/astra/scene.py", content: "print(1)" }, { path: "/vercel/sandbox/astra/input/a.png", content: Buffer.from([1, 2]) }]);
  const puts = pool.calls.filter((call) => call.method === "PUT");
  expect(puts.map((call) => [call.path, call.query])).toEqual([[`/v1/sessions/${NAME}/files`, "/vercel/sandbox/astra/scene.py"], [`/v1/sessions/${NAME}/files`, "/vercel/sandbox/astra/input/a.png"]]);
  expect(puts[0].body!.toString()).toBe("print(1)");
  await expect(handle.writeFiles([{ path: "/vercel/sandbox/astra/../../etc/passwd", content: "x" }])).rejects.toBeInstanceOf(AstraWorkerError);
  await expect(handle.writeFiles([{ path: "/tmp/elsewhere", content: "x" }])).rejects.toBeInstanceOf(AstraWorkerError);
  const ran = await handle.runCommand({ cmd: "/usr/bin/python3", args: ["/vercel/sandbox/astra/run.py"], cwd: "/vercel/sandbox/astra", timeoutMs: 165000 });
  expect(ran).toEqual({ exitCode: 0 });
  expect(JSON.parse(pool.calls.at(-1)!.body!.toString())).toEqual({ cmd: "/usr/bin/python3", args: ["run.py"], cwd: "/vercel/sandbox/astra", timeoutMs: 165000 });
  await expect(handle.runCommand({ cmd: "/usr/bin/python3", args: ["run.py"], timeoutMs: 180_001 })).rejects.toBeInstanceOf(AstraWorkerError);
  await expect(handle.runCommand({ cmd: "/bin/sh", args: ["-c", "id"], timeoutMs: 1000 })).rejects.toBeInstanceOf(AstraWorkerError);
  const stream = await handle.readFile({ path: "/vercel/sandbox/astra/output/scene.blend" });
  const chunks: Buffer[] = [];
  for await (const chunk of stream as Readable) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe("BLENDER-v502test");
  expect(await handle.readFile({ path: "/vercel/sandbox/astra/output/scene.glb" })).toBeNull();
  await expect(handle.readFile({ path: "/vercel/sandbox/astra/input/a.png" })).rejects.toBeInstanceOf(AstraWorkerError);
  pool.calls.length = 0;
  await handle.stop();
  // The stop's own reply carries the final usage: one call.
  expect(pool.calls.map((call) => call.method)).toEqual(["DELETE"]);
  expect(pool.running()).toEqual([]);
  expect(handle).toMatchObject({ status: "stopped", totalActiveCpuDurationMs: 12000, totalDurationMs: 15000, totalEgressBytes: 0 });
  // The read that follows a stop answers from the kept usage, with no call.
  pool.calls.length = 0;
  const after = await sdk.get({ name: NAME, resume: false });
  expect(after).toMatchObject({ status: "stopped", totalActiveCpuDurationMs: 12000, totalDurationMs: 15000, totalEgressBytes: 0 });
  expect(pool.calls).toEqual([]);
  expect(ASTRA_WORKER_RUN_TIMEOUT_MS).toBe(190_000);
  expect(ASTRA_WORKER_CALL_TIMEOUT_MS).toBe(30_000);
});

test("get finds the worker holding a name by asking each, never creates, and tells missing from unreachable", async () => {
  const pool = workerPool();
  pool.hold(W3, NAME);
  const handle = await sdkWith(pool).get({ name: NAME, resume: false });
  expect(handle).toMatchObject({ name: NAME, status: "running", totalActiveCpuDurationMs: 12000, totalDurationMs: 15000, totalEgressBytes: 0 });
  expect(pool.calls.map((call) => `${call.method} ${call.origin}`)).toEqual(WORKER_URLS.map((origin) => `GET ${origin}`));
  await handle.stop();
  expect(pool.calls.filter((call) => call.method === "DELETE").map((call) => call.origin)).toEqual([W3]);
  // Another process reads the stopped session on its worker, final usage included.
  forgetAstraWorkerSessions();
  expect(await sdkWith(pool).get({ name: NAME, resume: false })).toMatchObject({ status: "stopped", totalActiveCpuDurationMs: 12000, totalDurationMs: 15000, totalEgressBytes: 0 });
  // After that worker's next create the name is gone everywhere: missing, not unreachable.
  pool.sessions.delete(W3);
  await expect(sdkWith(pool).get({ name: NAME, resume: false })).rejects.toBeInstanceOf(AstraWorkerSessionMissingError);
  pool.set(W2, "down");
  const unreachable = await sdkWith(pool).get({ name: NAME, resume: false }).catch((e) => e);
  expect(unreachable).toBeInstanceOf(AstraWorkerError);
  expect(unreachable).not.toBeInstanceOf(AstraWorkerSessionMissingError);
  expect(pool.calls.some((call) => call.method === "POST")).toBe(false);
});

test("the fetch guard sends only to configured workers, under the session API, and refuses redirects", async () => {
  expect(astraWorkerUrl(config, W2, `/v1/sessions/${NAME}`).href).toBe(`${W2}/v1/sessions/${NAME}`);
  for (const [origin, path] of [["http://evil.test", "/v1/sessions"], ["http://render-1:8081", "/v1/sessions"], [W1, "//evil.test/v1/sessions"], [W1, "/admin"], [W1, "/v1/sessionsX"], [W1, "http://evil.test/v1/sessions"]])
    expect(() => astraWorkerUrl(config, origin, path), `${origin} ${path}`).toThrow(AstraWorkerError);
  // A worker that answers with a redirect is refused even if the fetch layer would surface it.
  const seen: RequestInit[] = [];
  const redirecting = async (_input: URL, init: RequestInit) => { seen.push(init); return new Response(null, { status: 302, headers: { location: "http://evil.test/v1/sessions" } }); };
  const error = await createSelfhostSdk({ config: { urls: [W1], secrets: [WORKER_SECRET] }, fetch: redirecting }).get({ name: NAME, resume: false }).catch((e) => e);
  expect(error).toBeInstanceOf(AstraWorkerError);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((init) => init.redirect === "error")).toBe(true);
  // Names are checked before any request.
  const pool = workerPool();
  await expect(sdkWith(pool).get({ name: "../../admin", resume: false })).rejects.toBeInstanceOf(AstraWorkerError);
  await expect(create(sdkWith(pool), "astra-blender-x/../../etc")).rejects.toBeInstanceOf(AstraWorkerError);
  expect(pool.calls).toEqual([]);
});

test("the worker secret never appears in an error or a log line", async () => {
  const lines: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(originals) as (keyof typeof originals)[]) console[level] = (...args: unknown[]) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" ")); };
  const errors: unknown[] = [];
  try {
    const capture = (promise: Promise<unknown>) => promise.then(() => {}, (error) => { errors.push(error); });
    for (const mode of ["down", "error", "refuse", "busy"] as const) {
      const pool = workerPool();
      for (const origin of WORKER_URLS) pool.set(origin, mode);
      await capture(create(sdkWith(pool)));
      await capture(sdkWith(pool).get({ name: NAME, resume: false }));
    }
    // A fetch layer whose own error text echoes the request headers.
    const echo = async (_input: URL, init: RequestInit) => { throw new Error(`request failed with headers ${JSON.stringify(init.headers)}`); };
    await capture(createSelfhostSdk({ config, fetch: echo }).create({ name: NAME } as never));
    await capture(createSelfhostSdk({ config, fetch: echo }).get({ name: NAME, resume: false }));
    const pool = workerPool();
    const handle = await create(sdkWith(pool));
    pool.set(W1, "down");
    await capture(handle.writeFiles([{ path: "/vercel/sandbox/astra/scene.py", content: "x" }]));
    await capture(handle.runCommand({ cmd: "/usr/bin/python3", args: ["run.py"], timeoutMs: 1000 }));
    await capture(handle.readFile({ path: "/vercel/sandbox/astra/output/scene.blend" }));
    await capture(handle.stop());
  } finally {
    Object.assign(console, originals);
  }
  expect(errors.length).toBeGreaterThanOrEqual(13);
  const text = [...lines, ...errors.map((error) => { const e = error as Error & { cause?: unknown }; return `${e.name} ${e.message} ${e.stack} ${JSON.stringify(e)} ${String(e.cause ?? "")}`; })].join("\n");
  expect(text).not.toContain(WORKER_SECRET);
  expect(text).not.toContain("render-1");
  expect(text).not.toMatch(/bearer/i);
});

test("a stop answered 404 is already gone and counts as stopped; a stop reply without usage is read back from the stopped session", async () => {
  const pool = workerPool();
  const handle = await create(sdkWith(pool));
  pool.sessions.delete(W1); // the worker's reaper (or a next create) already removed it
  await handle.stop();
  expect(handle.status).toBe("stopped");
  expect(handle.totalActiveCpuDurationMs).toBeUndefined();
  // Usage unknown: the job will hold its reservation as uncertain, never invent a figure.
  expect((await sdkWith(pool).get({ name: NAME, resume: false })).totalActiveCpuDurationMs).toBeUndefined();
  forgetAstraWorkerSessions();
  const quiet = workerPool();
  const bare = async (input: URL, init: RequestInit) => {
    const response = await quiet.fetch(input, init);
    return init.method === "DELETE" && response.ok ? new Response(null, { status: 200 }) : response;
  };
  const second = await createSelfhostSdk({ config, fetch: bare }).create({ name: NAME } as never);
  quiet.calls.length = 0;
  await second.stop();
  expect(quiet.calls.map((call) => call.method)).toEqual(["DELETE", "GET"]);
  expect(second).toMatchObject({ status: "stopped", totalActiveCpuDurationMs: 12000, totalDurationMs: 15000, totalEgressBytes: 0 });
  // A worker refusing the stop is not a confirmed stop.
  const refusing = async (input: URL, init: RequestInit) => init.method === "DELETE" ? new Response(null, { status: 500 }) : quiet.fetch(input, init);
  forgetAstraWorkerSessions();
  quiet.sessions.clear();
  const third = await createSelfhostSdk({ config, fetch: refusing }).create({ name: NAME } as never);
  await expect(third.stop()).rejects.toBeInstanceOf(AstraWorkerError);
});

const PER_WORKER = ["secret-for-render-1-0123456789abcdefghij", "secret-for-render-2-0123456789abcdefghij", "secret-for-render-3-0123456789abcdefghij"];

test("ASTRA_WORKER_SECRETS gives each worker its own secret, in URL order, and falls back to ASTRA_WORKER_SECRET when unset", () => {
  const urls = WORKER_URLS.join(",");
  // One secret per worker, same order as the URLs; the shared secret is then not used.
  expect(astraSelfhostConfig({ ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRETS: ` ${PER_WORKER.join(" , ")} ` })).toEqual({ urls: WORKER_URLS, secrets: PER_WORKER });
  expect(astraSelfhostConfig({ ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRETS: PER_WORKER.join(","), ASTRA_WORKER_SECRET: WORKER_SECRET })?.secrets).toEqual(PER_WORKER);
  // Unset or blank: the single secret applies to every worker, as before.
  expect(astraSelfhostConfig({ ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRET: WORKER_SECRET })?.secrets).toEqual([WORKER_SECRET, WORKER_SECRET, WORKER_SECRET]);
  expect(astraSelfhostConfig({ ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRETS: " ", ASTRA_WORKER_SECRET: WORKER_SECRET })?.secrets).toEqual([WORKER_SECRET, WORKER_SECRET, WORKER_SECRET]);
  // A count that differs from the URL count, a short or empty entry: not configured (the shared secret does not paper over it).
  for (const list of [PER_WORKER.slice(0, 2).join(","), [...PER_WORKER, PER_WORKER[0]].join(","), `${PER_WORKER[0]},${PER_WORKER[1]},short`, `${PER_WORKER[0]},,${PER_WORKER[2]}`])
    expect(astraSelfhostConfig({ ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRETS: list, ASTRA_WORKER_SECRET: WORKER_SECRET }), list.length.toString()).toBeNull();
  const mismatch = withEnv({ ASTRA_RENDER_BACKEND: "selfhost", ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRETS: PER_WORKER.slice(0, 2).join(","), ASTRA_WORKER_SECRET: WORKER_SECRET }, () => astraRuntimeStatus());
  expect(mismatch.configured).toBe(false);
  expect(mismatch.reason).toContain("render workers");
  expect(withEnv({ ASTRA_RENDER_BACKEND: "selfhost", ASTRA_WORKER_URLS: urls, ASTRA_WORKER_SECRETS: PER_WORKER.join(",") }, () => astraRuntimeStatus().configured)).toBe(true);
});

test("each worker URL is sent its own bearer and never another worker's, and no secret reaches an error", async () => {
  const pool = workerPool(WORKER_URLS, Object.fromEntries(WORKER_URLS.map((origin, i) => [origin, PER_WORKER[i]])));
  pool.set(W1, "busy"); pool.set(W2, "busy");
  const sdk = createSelfhostSdk({ config: { urls: WORKER_URLS, secrets: PER_WORKER }, fetch: pool.fetch });
  const handle = await create(sdk);
  await handle.writeFiles([{ path: "/vercel/sandbox/astra/scene.py", content: "x" }]);
  await handle.stop();
  forgetAstraWorkerSessions();
  await sdk.get({ name: NAME, resume: false });
  expect(pool.calls.length).toBeGreaterThan(5);
  for (const call of pool.calls) expect(call.authorization).toBe(`Bearer ${PER_WORKER[WORKER_URLS.indexOf(call.origin)]}`);
  expect(pool.calls.filter((call) => call.origin === W3).map((call) => call.method)).toEqual(["POST", "PUT", "DELETE", "GET"]);
  // Secrets in the wrong order: every worker refuses, and the error names none of them.
  const swapped = createSelfhostSdk({ config: { urls: WORKER_URLS, secrets: [PER_WORKER[1], PER_WORKER[2], PER_WORKER[0]] }, fetch: workerPool(WORKER_URLS, Object.fromEntries(WORKER_URLS.map((origin, i) => [origin, PER_WORKER[i]]))).fetch });
  const error = await create(swapped, "astra-blender-00000000-0000-4000-8000-000000000003").catch((e) => e);
  expect(error).toBeInstanceOf(AstraWorkerRefusedError);
  const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
  for (const secret of PER_WORKER) expect(text).not.toContain(secret);
});
