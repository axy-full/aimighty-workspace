import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXPORT_WORKER_SECRET, exportWorkerPool } from "./remotionWorkerFake";

const directory = mkdtempSync(path.join(tmpdir(), "export-worker-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const NAME = () => `remotion-export-${crypto.randomUUID()}`;

test("the worker client takes the first free worker, uses each worker's own secret, and runs only the fixed command", async () => {
  const { openExportSession } = await import("../../lib/exports/worker");
  const urls = ["http://remotion-1:8790", "http://remotion-2:8790"];
  const secrets = { [urls[0]]: "first-secret-0123456789-0123456789-abc", [urls[1]]: "second-secret-0123456789-0123456789-ab" };
  const pool = exportWorkerPool(urls, secrets);
  pool.set(urls[0], "busy");
  const config = { urls, secrets: urls.map((url) => secrets[url]) };
  const session = await openExportSession(NAME(), { config, fetch: pool.fetch });
  expect(session.worker).toBe(1);
  await session.putFile("spec.json", "{}");
  await session.putFile("input/m1.mp4", Buffer.from("clip"));
  const reply = await session.run(120_000);
  expect(reply).toMatchObject({ exitCode: 0, timedOut: false });
  expect((await session.readOutput("export.mp4"))?.length).toBeGreaterThan(16);
  expect(await session.readOutput("still-9.png")).toBeNull();
  await session.stop();
  await session.stop();
  // Each worker was sent its own secret, and only its own.
  for (const call of pool.calls) expect(call.authorization).toBe(`Bearer ${secrets[call.origin]}`);
  // The command is exactly the protocol's, nothing else; redirects are never followed.
  const run = pool.calls.find((call) => call.path.endsWith("/run"))!;
  expect(JSON.parse(run.body!.toString())).toEqual({ cmd: "/usr/local/bin/node", args: ["/opt/remotion/cli.mjs"], cwd: "/vercel/sandbox/remotion", timeoutMs: 120000 });
  expect(new Set(pool.calls.map((call) => call.redirect))).toEqual(new Set(["error"]));
  expect(pool.calls.filter((call) => call.method === "PUT").map((call) => call.query)).toEqual(["/vercel/sandbox/remotion/spec.json", "/vercel/sandbox/remotion/input/m1.mp4"]);
});

test("busy, refused, unreachable and half-answered workers each end as the right thing, and no message names a host or a secret", async () => {
  const { openExportSession, ExportWorkerBusyError, ExportWorkerRefusedError, ExportWorkerError } = await import("../../lib/exports/worker");
  const make = (mode: "busy" | "refuse" | "down" | "error") => { const pool = exportWorkerPool(); pool.set("http://remotion-1:8790", mode); return pool; };
  const open = (pool: ReturnType<typeof exportWorkerPool>) => openExportSession(NAME(), { config: pool.config, fetch: pool.fetch });
  await expect(open(make("busy"))).rejects.toBeInstanceOf(ExportWorkerBusyError);
  await expect(open(make("refuse"))).rejects.toBeInstanceOf(ExportWorkerRefusedError);
  // Unreachable: the attempt is cleared with a DELETE; unconfirmed means the export may have begun, so it is an error, not "busy".
  const down = make("down");
  const error = await open(down).catch((e) => e);
  expect(error).toBeInstanceOf(ExportWorkerError);
  expect(error).not.toBeInstanceOf(ExportWorkerBusyError);
  for (const message of [error.message, new ExportWorkerBusyError().message, new ExportWorkerRefusedError().message]) {
    expect(message).not.toContain("remotion-1");
    expect(message).not.toContain(EXPORT_WORKER_SECRET);
  }
  // A worker that answers 500 to the create is cleared with a DELETE, and if that is confirmed, treated as unavailable (busy).
  const broken = make("error");
  await expect(open(broken)).rejects.toBeInstanceOf(Error);
  // No configuration: refused, and nothing is sent.
  const none = exportWorkerPool();
  await expect(openExportSession(NAME(), { config: null, fetch: none.fetch })).rejects.toBeInstanceOf(ExportWorkerRefusedError);
  expect(none.calls).toEqual([]);
  await expect(openExportSession("not-a-name", { config: none.config, fetch: none.fetch })).rejects.toThrow("Invalid export identity");
});

test("a redirect is refused, file names cannot climb, and the run time is bounded", async () => {
  const { openExportSession } = await import("../../lib/exports/worker");
  const pool = exportWorkerPool();
  const session = await openExportSession(NAME(), { config: pool.config, fetch: pool.fetch });
  for (const bad of ["../x", "a/../b", "/etc/passwd", "a\\b", "", "a//b", "./a"]) {
    await expect(session.putFile(bad, "x")).rejects.toThrow("refused");
    await expect(session.readOutput(bad)).rejects.toThrow("refused");
  }
  for (const timeout of [0, -1, 1.5, 900_001]) await expect(session.run(timeout)).rejects.toThrow("refused");
  const redirecting = { urls: pool.config.urls, secrets: pool.config.secrets };
  const redirect = async () => new Response(null, { status: 302, headers: { location: "http://evil.test/" } });
  await expect(openExportSession(NAME(), { config: redirecting, fetch: redirect })).rejects.toBeInstanceOf(Error);
  expect(pool.calls.every((call) => call.origin === "http://remotion-1:8790")).toBe(true);
  await session.stop();
});

test("the worker route carries the export event: identifiers only, one slot per worker, and the workspace's share from the platform", async () => {
  const { EVENTS, WORKER_EVENT_NAMES } = await import("../../lib/dispatch");
  const { workerJobId, handleExportRender } = await import("../../lib/worker-handlers");
  const { workerSlotLimit, workerSlotWorkspaceLimit, acquireSlot, releaseSlot } = await import("../../lib/worker-slots");
  expect(EVENTS.exportRender).toBe("remotion/export.requested");
  expect(WORKER_EVENT_NAMES).toContain(EVENTS.exportRender);
  const id = "export_" + "d".repeat(32);
  expect(workerJobId({ id: "e", name: EVENTS.exportRender, data: { jobId: id, workspaceId: "ws_a" } })).toBe(id);
  const keys = ["REMOTION_WORKER_URLS", "REMOTION_WORKER_SECRETS", "REMOTION_EXPORT_MAX_RUNNING"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.REMOTION_WORKER_URLS = "http://remotion-1:8790";
    process.env.REMOTION_WORKER_SECRETS = EXPORT_WORKER_SECRET;
    delete process.env.REMOTION_EXPORT_MAX_RUNNING;
    expect([workerSlotLimit(EVENTS.exportRender), workerSlotWorkspaceLimit(EVENTS.exportRender)]).toEqual([1, 1]);
    // Everything else keeps its numbers.
    expect([workerSlotLimit(EVENTS.render), workerSlotWorkspaceLimit(EVENTS.render), workerSlotLimit(EVENTS.astraRender)]).toEqual([4, 2, 3]);
    const first = await acquireSlot({ kind: EVENTS.exportRender, workspaceId: "ws_a", jobId: "export_one" });
    expect(first).not.toBeNull();
    // One worker: nobody else runs an export now.
    expect(await acquireSlot({ kind: EVENTS.exportRender, workspaceId: "ws_b", jobId: "export_two" })).toBeNull();
    await releaseSlot(first!.id);
    // Three workers, one running per workspace: a second export of the same workspace waits; another workspace's runs.
    process.env.REMOTION_WORKER_URLS = "http://r1:8790,http://r2:8790,http://r3:8790";
    process.env.REMOTION_WORKER_SECRETS = [EXPORT_WORKER_SECRET, `${EXPORT_WORKER_SECRET}2`, `${EXPORT_WORKER_SECRET}3`].join(",");
    const a1 = await acquireSlot({ kind: EVENTS.exportRender, workspaceId: "ws_a", jobId: "export_three" });
    expect(a1).not.toBeNull();
    expect(await acquireSlot({ kind: EVENTS.exportRender, workspaceId: "ws_a", jobId: "export_four" })).toBeNull();
    const b1 = await acquireSlot({ kind: EVENTS.exportRender, workspaceId: "ws_b", jobId: "export_five" });
    expect(b1).not.toBeNull();
    // The platform raises a workspace's share to two.
    process.env.REMOTION_EXPORT_MAX_RUNNING = "2";
    const a2 = await acquireSlot({ kind: EVENTS.exportRender, workspaceId: "ws_a", jobId: "export_six" });
    expect(a2).not.toBeNull();
    for (const slot of [a1, a2, b1]) await releaseSlot(slot!.id);
  } finally {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
  // The handler runs the export once in its own workspace and reports a queue that stayed queued.
  const seen: string[] = [];
  const workspace = { id: "ws_h", deletedAt: null } as never;
  const run = (outcome: "busy" | "waiting" | undefined) => handleExportRender({ jobId: id, workspaceId: "ws_h" }, { workspaceOf: async () => workspace, run: async (jobId) => { seen.push(jobId); return outcome; } });
  expect(await run(undefined)).toEqual({ jobId: id });
  expect(await run("busy")).toEqual({ jobId: id, busy: true });
  expect(await run("waiting")).toEqual({ jobId: id, waiting: true });
  expect(seen).toEqual([id, id, id]);
});

test("a worker that answers 409 while a file is going up or a run is asked for is told plainly (the app sends files one at a time, so this should not happen)", async () => {
  const { openExportSession } = await import("../../lib/exports/worker");
  const urls = ["http://remotion-1:8790"];
  const secrets = { [urls[0]]: "first-secret-0123456789-0123456789-abc" };
  const pool = exportWorkerPool(urls, secrets);
  const config = { urls, secrets: urls.map((url) => secrets[url]) };
  const busy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input);
    if ((init?.method === "PUT") || target.endsWith("/run")) return new Response(JSON.stringify({ error: "run_in_progress" }), { status: 409, headers: { "content-type": "application/json" } });
    return pool.fetch(input as never, init as never);
  }) as typeof fetch;
  const session = await openExportSession(NAME(), { config, fetch: busy as never });
  await expect(session.putFile("spec.json", "{}")).rejects.toThrow("An export worker was still busy with this export when a file was sent.");
  await expect(session.run(120_000)).rejects.toThrow("An export worker was still busy with this export when it was asked to run it.");
  await session.stop();
  /* Any other refusal keeps its own words. */
  const refused = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "PUT" ? new Response("{}", { status: 413 }) : pool.fetch(input as never, init as never))) as typeof fetch;
  const other = await openExportSession(NAME(), { config, fetch: refused as never });
  await expect(other.putFile("spec.json", "{}")).rejects.toThrow("An export worker did not accept a file.");
});
