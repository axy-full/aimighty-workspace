#!/usr/bin/env node
/** Isolated SQLite rehearsal. This never accepts an application/database target. */
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export function validateLocalDatabase(url, directory) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "file:" ||
    parsed.hostname ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("ONLY_ISOLATED_FILE_DATABASES_ALLOWED");
  const filename = fileURLToPath(parsed),
    relative = path.relative(path.resolve(directory), filename);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("DATABASE_OUTSIDE_FIXTURE");
  return filename;
}
export function parseOptions(args) {
  const options = {
    concurrency: 8,
    processes: 2,
    durationMs: 2000,
    workspaces: 2,
    activeLimit: 2,
    keepFixtures: false,
  };
  const names = {
    "--concurrency": "concurrency",
    "--processes": "processes",
    "--duration-ms": "durationMs",
    "--workspaces": "workspaces",
    "--active-limit": "activeLimit",
    "--output": "output",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keep-fixtures") {
      options.keepFixtures = true;
      continue;
    }
    const key = names[args[i]];
    if (!key || !args[i + 1]) throw new Error("UNKNOWN_OR_MISSING_OPTION");
    options[key] =
      key === "output" ? path.resolve(args[++i]) : Number(args[++i]);
  }
  for (const [key, min, max] of [
    ["concurrency", 1, 64],
    ["processes", 1, 8],
    ["durationMs", 100, 600000],
    ["workspaces", 1, 8],
    ["activeLimit", 1, 32],
  ]) {
    if (
      !Number.isInteger(options[key]) ||
      options[key] < min ||
      options[key] > max
    )
      throw new Error(`INVALID_${key.toUpperCase()}`);
  }
  if (options.processes > options.concurrency)
    throw new Error("PROCESSES_EXCEED_CONCURRENCY");
  return options;
}
export function summarizeSamples(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) =>
    sorted.length
      ? Math.round(
          sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] * 1000,
        ) / 1000
      : null;
  return {
    count: sorted.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    maxMs: at(1),
  };
}
/** Verify positive provider-boundary coverage, not just absence of duplicates. */
export function paidEntryCoverage(charges, entries, refusedJobIds) {
  const byId = new Map();
  for (const entry of entries)
    byId.set(entry.id, (byId.get(entry.id) ?? 0) + 1);
  return (
    charges
      .filter((row) => row.status === "succeeded")
      .every((row) => byId.get(String(row.id)) === 1) &&
    refusedJobIds.every((id) => !byId.has(String(id))) &&
    entries.every((entry) =>
      charges.some((row) => String(row.id) === entry.id),
    ) &&
    [...byId.values()].every((count) => count === 1)
  );
}
function cleanEnvironment(directory) {
  if (process.env.VERCEL || process.env.NODE_ENV === "production")
    throw new Error("LOCAL_REHEARSAL_ONLY");
  // Refuse inherited remote targets before replacing the entire child environment.
  for (const key of ["PLATFORM_DATABASE_URL", "TURSO_DATABASE_URL"])
    if (process.env[key] && !process.env[key].startsWith("file:"))
      throw new Error("REMOTE_DATABASE_ENVIRONMENT_REFUSED");
  return {
    PATH: process.env.PATH ?? "",
    LANG: "en_US.UTF-8",
    TMPDIR: directory,
    NODE_ENV: "test",
    ENGINE_MOCK: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    PAYMENT_PROVIDER: "manual",
    PLATFORM_DATABASE_URL: pathToFileURL(path.join(directory, "platform.db"))
      .href,
    TURSO_DATABASE_URL: pathToFileURL(path.join(directory, "primary.db")).href,
    KEYRING_SECRET: "isolated-load-rehearsal-placeholder-secret-32",
    CREDIT_USD: "0.10",
    SUPER_ADMIN_EMAIL: "load@example.test",
    LEGACY_WORKSPACE_NAME: "Local load fixture",
  };
}
export async function sourceDigest(sourceRoot = root) {
  const files = (await readdir(path.join(sourceRoot, "lib"), { recursive: true }))
    .filter((file) => /\.(?:[cm]?js|tsx?)$/.test(file))
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(path.join(sourceRoot, "lib", file)))
      .update("\0");
  for (const file of [
    "package.json",
    "package-lock.json",
    "scripts/ops/load-rehearsal.mjs",
    "scripts/ops/load-rehearsal-runtime.cjs",
  ])
    hash.update(await readFile(path.join(sourceRoot, file)));
  return hash.digest("hex");
}
async function child(configFile, environment, mode, index = 0) {
  const processHandle = fork(
    path.join(root, "scripts/ops/load-rehearsal-runtime.cjs"),
    [configFile, mode, String(index)],
    {
      cwd: root,
      env: environment,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const queued = [],
    waiters = new Map();
  let exited = false,
    diagnostic = "";
  const exitPromise = new Promise((resolve) =>
    processHandle.once("exit", resolve),
  );
  processHandle.stderr.on("data", (bytes) => {
    diagnostic = (diagnostic + bytes.toString()).slice(-4000);
  });
  processHandle.on("message", (message) => {
    const waiter = waiters.get(message.type);
    if (waiter) {
      waiters.delete(message.type);
      waiter.resolve(message);
    } else queued.push(message);
    if (message.type === "fatal")
      for (const pending of waiters.values())
        pending.reject(new Error(message.code));
  });
  processHandle.on("exit", (code) => {
    if (code && diagnostic)
      void writeFile(
        path.join(path.dirname(configFile), `child-${mode}-${index}.log`),
        diagnostic,
        { mode: 0o600 },
      );
    exited = true;
    for (const pending of waiters.values())
      pending.reject(
        new Error(
          `CHILD_EXIT_${code}${diagnostic.includes("SQLITE_BUSY") ? "_SQLITE_BUSY" : ""}`,
        ),
      );
    waiters.clear();
  });
  function wait(type, timeoutMs = 120000) {
    const fatal = queued.find((message) => message.type === "fatal");
    if (fatal) return Promise.reject(new Error(fatal.code));
    const found = queued.findIndex((message) => message.type === type);
    if (found >= 0) return Promise.resolve(queued.splice(found, 1)[0]);
    if (exited) return Promise.reject(new Error("CHILD_ALREADY_EXITED"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(type);
        reject(new Error(`CHILD_TIMEOUT_${type}`));
      }, timeoutMs);
      waiters.set(type, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }
  return {
    wait,
    send: (value) => processHandle.send(value),
    stop: async () => {
      if (exited) return;
      processHandle.kill("SIGTERM");
      const forced = setTimeout(() => processHandle.kill("SIGKILL"), 5000);
      try {
        await exitPromise;
      } finally {
        clearTimeout(forced);
      }
    },
  };
}
export async function runRehearsal(input = {}) {
  const options = { ...parseOptions([]), ...input };
  // Reuse CLI validation for programmatic callers too.
  parseOptions(
    Object.entries({
      "--concurrency": options.concurrency,
      "--processes": options.processes,
      "--duration-ms": options.durationMs,
      "--workspaces": options.workspaces,
      "--active-limit": options.activeLimit,
    }).flatMap(([k, v]) => [k, String(v)]),
  );
  const directory = await mkdtemp(path.join(tmpdir(), "particl-load-"));
  const handles = [];
  let report;
  try {
    const beforeDigest = await sourceDigest();
    const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const environment = cleanEnvironment(directory),
      configFile = path.join(directory, "load-fixture.json");
    const config = { ...options, directory, fixtureId: randomUUID(), root };
    validateLocalDatabase(environment.PLATFORM_DATABASE_URL, directory);
    await writeFile(configFile, JSON.stringify(config), {
      flag: "wx",
      mode: 0o600,
    });
    const setup = await child(configFile, environment, "setup");
    handles.push(setup);
    await setup.wait("ready");
    await setup.stop();
    const workers = [];
    // Warm schema/module caches sequentially, then measure concurrent work only.
    for (let index = 0; index < options.processes; index++) {
      const worker = await child(configFile, environment, "worker", index);
      handles.push(worker);
      await worker.wait("ready");
      workers.push(worker);
    }
    const startedAt = new Date().toISOString(),
      start = performance.now(),
      until = Date.now() + options.durationMs;
    workers.forEach((worker) => worker.send({ type: "start", until }));
    const outcomes = await Promise.all(
      workers.map((worker) =>
        worker.wait("completed", options.durationMs + 120000),
      ),
    );
    const measuredDurationMs = Math.round(performance.now() - start);
    workers.forEach((worker) => worker.send({ type: "budget" }));
    const budgets = await Promise.all(
      workers.map((worker) => worker.wait("budget-completed")),
    );
    const actions = {
      acknowledgedDrafts: [],
      paidEntries: [],
      callbackEntries: [],
      leaseObservations: [],
      blockedNetwork: 0,
    };
    for (const result of [...outcomes, ...budgets]) {
      for (const key of [
        "acknowledgedDrafts",
        "paidEntries",
        "callbackEntries",
        "leaseObservations",
      ])
        actions[key].push(...result[key]);
      actions.blockedNetwork += result.blockedNetwork;
    }
    await writeFile(
      path.join(directory, "observed-actions.json"),
      JSON.stringify(actions),
      { flag: "wx", mode: 0o600 },
    );
    await Promise.all(workers.map((worker) => worker.stop()));
    const verify = await child(configFile, environment, "verify");
    handles.push(verify);
    const final = await verify.wait("verified");
    await verify.stop();
    const samples = {},
      errors = {},
      counters = {};
    for (const result of [...outcomes, ...budgets]) {
      for (const [key, values] of Object.entries(result.samples ?? {}))
        (samples[key] ??= []).push(...values);
      for (const [key, value] of Object.entries(result.errors ?? {}))
        errors[key] = (errors[key] ?? 0) + value;
      for (const [key, value] of Object.entries(result.counters ?? {}))
        counters[key] = (counters[key] ?? 0) + value;
    }
    const metrics = Object.fromEntries(
      Object.entries(samples).map(([key, values]) => [
        key,
        summarizeSamples(values),
      ]),
    );
    const unexpectedErrors = Object.values(errors).reduce((a, b) => a + b, 0),
      measuredOperations =
        (counters.work_item_attempts ?? 0) +
        (counters.budget_work_item_attempts ?? 0);
    final.invariants.sourceUnchangedDuringRun =
      beforeDigest === (await sourceDigest());
    report = {
      schemaVersion: 1,
      ok:
        unexpectedErrors === 0 &&
        Object.values(final.invariants).every(Boolean),
      startedAt,
      finishedAt: new Date().toISOString(),
      measuredDurationMs,
      totalWithVerificationMs: Math.round(performance.now() - start),
      sourceRevision,
      sourceDigest: beforeDigest,
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      workload: {
        concurrency: options.concurrency,
        processes: options.processes,
        workspaces: options.workspaces,
        activeLimit: options.activeLimit,
        requestedDurationMs: options.durationMs,
        database: "local SQLite, fresh fixtures",
        fakeBoundary:
          "event transport and provider outcome only; no image/audio/video model invoked",
      },
      measuredOperations,
      unexpectedErrors,
      unexpectedErrorRate: measuredOperations
        ? unexpectedErrors / measuredOperations
        : 0,
      errors,
      counters,
      metrics,
      invariants: final.invariants,
      observations: final.observations,
      limitations: [
        "Local SQLite source-module rehearsal, not Vercel/Turso/Inngest or provider capacity evidence.",
        "Latency excludes warm-up and uses closed-loop clients; expected credit/slot/CAS refusals are counted separately.",
        "No HTTP, browser, uploads, media encoding or paid-provider latency is exercised.",
        "Fixture SQL triggers record active-slot and debit high-water marks; this instrumentation is included in latency.",
      ],
      ...(options.keepFixtures ? { fixtureDirectory: directory } : {}),
    };
  } finally {
    await Promise.all(handles.map((handle) => handle.stop()));
    if (!options.keepFixtures)
      await rm(directory, { recursive: true, force: true });
  }
  if (options.output)
    await writeFile(options.output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  return report;
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const report = await runRehearsal(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "LOAD_REHEARSAL_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
