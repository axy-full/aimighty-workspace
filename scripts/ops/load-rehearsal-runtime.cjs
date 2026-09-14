/* eslint-disable @typescript-eslint/no-require-imports -- This isolated CommonJS child installs synchronous source/client guards before loading application modules. */
/* Child-only runtime for load-rehearsal.mjs. Never run against an existing app. */
const fs = require("node:fs"),
  path = require("node:path"),
  Module = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");
const [configFile, mode, workerIndexRaw] = process.argv.slice(2),
  workerIndex = Number(workerIndexRaw || 0);
const root = path.resolve(__dirname, "../.."),
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
if (
  !process.send ||
  path.dirname(configFile) !== config.directory ||
  !path.basename(config.directory).startsWith("particl-load-") ||
  config.root !== root ||
  !/^[a-f0-9-]{36}$/.test(config.fixtureId)
)
  throw new Error("ISOLATED_CHILD_REQUIRED");
const fixture = fs.realpathSync(config.directory);
function validateUrl(url) {
  const parsed = new URL(String(url));
  if (
    parsed.protocol !== "file:" ||
    parsed.hostname ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("REMOTE_DATABASE_BLOCKED");
  const filename = fileURLToPath(parsed),
    relative = path.relative(
      fixture,
      path.join(
        fs.realpathSync(path.dirname(filename)),
        path.basename(filename),
      ),
    );
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    fs.realpathSync(path.dirname(filename)) !== fixture
  )
    throw new Error("DATABASE_OUTSIDE_FIXTURE");
  if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink())
    throw new Error("SYMLINK_DATABASE_BLOCKED");
}
validateUrl(process.env.PLATFORM_DATABASE_URL);
validateUrl(process.env.TURSO_DATABASE_URL);
let blockedNetwork = 0;
function noNetwork() {
  blockedNetwork++;
  throw new Error("REHEARSAL_NETWORK_BLOCKED");
}
globalThis.fetch = noNetwork;
require("node:net").Socket.prototype.connect = noNetwork;
require("node:dgram").createSocket = noNetwork;
for (const name of ["node:http", "node:https", "node:http2"]) {
  const api = require(name);
  for (const method of ["request", "get", "connect"])
    if (api[method]) api[method] = noNetwork;
}
// Compile current source in this disposable process. No app source or build output changes.
const ts = require("typescript"),
  originalResolve = Module._resolveFilename,
  originalLoad = Module._load;
Module._resolveFilename = function (specifier, parent, ...args) {
  return originalResolve.call(
    this,
    specifier.startsWith("@/")
      ? path.join(root, specifier.slice(2))
      : specifier,
    parent,
    ...args,
  );
};
Module._extensions[".ts"] = function (module, filename) {
  if (
    !filename.startsWith(root + path.sep) ||
    filename.includes(`${path.sep}node_modules${path.sep}`)
  )
    throw new Error("UNEXPECTED_TYPESCRIPT_SOURCE");
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  module._compile(output.outputText, filename);
};
Module._load = function (specifier, ...args) {
  const loaded = originalLoad.call(this, specifier, ...args);
  if (specifier !== "@libsql/client") return loaded;
  return {
    ...loaded,
    createClient(options) {
      validateUrl(options.url);
      if (options.syncUrl || options.authToken)
        throw new Error("REMOTE_DATABASE_OPTIONS_BLOCKED");
      return loaded.createClient(options);
    },
  };
};
const load = (name) => require(path.join(root, "lib", name));
const tenant = load("tenant.ts"),
  database = load("db.ts"),
  platform = load("platform.ts");
const requests = load("generationRequests.ts"),
  settlements = load("generationSettlement.ts"),
  dispatch = load("renderDispatch.ts");
const { claimRender } = load("renderWork.ts"),
  { reconcileWorkspaces } = load("reconciliation.ts");
const { saveDraft, readDraft, workbenchReady } = load("workbench/records.ts"),
  { newProject } = load("workbench/studio.ts");
const { billingStateFor } = load("billingLedger.ts"),
  { billCredits, marginKeyOf } = load("creditTerms.ts");
const user = {
  id: "user_load",
  email: "load@example.test",
  name: "Local fixture",
  role: "admin",
  owner: true,
  disabled: false,
  lastSeen: null,
  createdAt: 0,
};
const estimate = 0.1,
  actual = 0.04,
  kind = "image",
  model = "gemini-3.1-flash-image",
  engine = "google";
const workspaces = Array.from({ length: config.workspaces + 1 }, (_, i) => ({
  id: i === config.workspaces ? "ws_load_budget" : `ws_load_${i}`,
  slug: `load-${i}`,
  name: "Local load fixture",
  legacy: false,
  dbUrl: pathToFileURL(path.join(fixture, `tenant-${i}.db`)).href,
  dbToken: null,
  keys: {},
  usesPlatformKeys: true,
  allowanceUsd: null,
  gatewayKeyId: null,
  ownerId: user.id,
  createdAt: Date.now(),
  suspendedAt: null,
  suspendedReason: null,
  flaggedAt: null,
  flagNote: null,
  concurrency: i === config.workspaces ? 100 : config.activeLimit,
  rendersPerHour: 1000000,
  storageQuotaBytes: null,
  deletedAt: null,
}));
const scoped = (ws, fn) => tenant.runInTenant(ws, fn, { user });
const eventFor = (id) => ({
  id,
  kind,
  engine,
  model,
  status: "running",
  engineCostUsd: estimate,
  createdBy: user.id,
});
let samples = {},
  errors = {},
  counters = {},
  sequence = 0,
  phase = "load";
let acknowledgedDrafts = [],
  paidEntries = [],
  callbackEntries = [],
  leaseObservations = [];
function count(name, value = 1) {
  if (phase === "budget") name = `budget_${name}`;
  counters[name] = (counters[name] ?? 0) + value;
}
function errorCode(error) {
  const message = String(error?.message ?? error);
  return /SQLITE_BUSY/.test(message)
    ? "SQLITE_BUSY"
    : /REQUEST_STATUS_5\d\d/.test(message)
      ? message.match(/REQUEST_STATUS_5\d\d/)[0]
      : /SQLITE_CONSTRAINT/.test(message)
        ? "SQLITE_CONSTRAINT"
        : /REHEARSAL_NETWORK/.test(message)
          ? "NETWORK_BLOCKED"
          : "UNEXPECTED_OPERATION_ERROR";
}
async function measure(name, fn) {
  if (phase === "budget") name = `budget_${name}`;
  const start = performance.now();
  try {
    return await fn();
  } finally {
    (samples[name] ??= []).push(performance.now() - start);
  }
}
function unexpected(error) {
  const code = errorCode(error);
  errors[code] = (errors[code] ?? 0) + 1;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function initialize(setup = false) {
  await platform.platformReady();
  const p = platform.platformDb();
  if (setup) {
    await p.batch(
      [
        `CREATE TABLE load_observations(id INTEGER PRIMARY KEY,workspace_id TEXT,active INTEGER,billed REAL)`,
        `CREATE TRIGGER load_meter_insert AFTER INSERT ON meter_events BEGIN
        INSERT INTO load_observations(workspace_id,active,billed) SELECT NEW.workspace_id,
        (SELECT COUNT(*) FROM meter_events WHERE workspace_id=NEW.workspace_id AND status='running'),
        (SELECT COALESCE(SUM(billed_credits),0) FROM meter_events WHERE workspace_id=NEW.workspace_id); END`,
        `CREATE TRIGGER load_meter_update AFTER UPDATE ON meter_events BEGIN
        INSERT INTO load_observations(workspace_id,active,billed) SELECT NEW.workspace_id,
        (SELECT COUNT(*) FROM meter_events WHERE workspace_id=NEW.workspace_id AND status='running'),
        (SELECT COALESCE(SUM(billed_credits),0) FROM meter_events WHERE workspace_id=NEW.workspace_id); END`,
      ],
      "write",
    );
  }
  for (const ws of workspaces) {
    if (setup)
      await p.batch(
        [
          {
            sql: `INSERT INTO workspaces(id,slug,name,db_url,owner_id,uses_platform_keys,plan_id,concurrency,renders_per_hour,created_at,updated_at) VALUES(?,?,?,?,?,1,'agency',?,?,?,?)`,
            args: [
              ws.id,
              ws.slug,
              ws.name,
              ws.dbUrl,
              ws.ownerId,
              ws.concurrency,
              ws.rendersPerHour,
              ws.createdAt,
              ws.createdAt,
            ],
          },
          {
            sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'Local load fixture',?)",
            args: [
              `grant_${ws.id}`,
              ws.id,
              ws.id === "ws_load_budget" ? 7 : 100000,
              Date.now(),
            ],
          },
        ],
        "write",
      );
    await scoped(ws, async () => {
      await database.ready();
      await requests.generationRequestsReady();
      await settlements.generationSettlementReady();
      await dispatch.renderDispatchReady();
      await workbenchReady();
      if (setup) {
        await database.db().batch(
          [
            {
              sql: "INSERT INTO projects(id,name,description,created_at) VALUES(?,?,?,?)",
              args: [
                `prj_${ws.id}`,
                "Load production",
                "Isolated fixture",
                Date.now(),
              ],
            },
          ],
          "write",
        );
        const project = {
          ...newProject("Load draft"),
          id: `draft_${ws.id}`,
          productionProjectId: `prj_${ws.id}`,
          script: "",
        };
        await saveDraft(user.id, project, 0);
      }
      await billingStateFor(ws.id);
    });
  }
}
async function insertJob(id) {
  await database.db().execute({
    sql: `INSERT INTO generations(id,kind,provider,billed_to,model,prompt,params,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'Local rehearsal','{}','running',?,?,?)`,
    args: [id, kind, engine, engine, model, user.id, Date.now(), Date.now()],
  });
}
async function reserve(id) {
  try {
    await measure("reserve", () =>
      requests.reserveGenerationSpend(eventFor(id)),
    );
    count("admitted");
    return true;
  } catch (error) {
    if ([402, 409, 429].includes(error.status)) {
      count(`expected_admission_${error.status}`);
      await database.db().execute({
        sql: "UPDATE generations SET status='failed',error='Expected rehearsal backpressure' WHERE id=?",
        args: [id],
      });
      return false;
    }
    throw error;
  }
}
async function enterPaidBoundary(id) {
  if (await claimRender(id)) {
    paidEntries.push({ id, workspaceId: tenant.requireTenant().id });
    count("simulated_provider_entries");
  }
}
async function settle(id) {
  await settlements.writeGenerationOutcome(
    {
      sql: "UPDATE generations SET status='succeeded',cost_usd=?,stored_url='local-fixture-output',updated_at=? WHERE id=? AND status='running'",
      args: [actual, Date.now(), id],
    },
    { ...eventFor(id), status: "succeeded", engineCostUsd: actual },
  );
  await measure("settlement", () =>
    Promise.all([
      settlements.deliverGenerationSettlement(id),
      settlements.deliverGenerationSettlement(id),
    ]),
  );
  count("settled_jobs");
}
async function job(ws, id) {
  return scoped(ws, () =>
    measure("job", async () => {
      const request = () =>
        new Request("http://fixture.invalid/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `load:${id}`,
          },
          body: JSON.stringify({ prompt: "Local rehearsal", model }),
        });
      const callback = async (claim) => {
        callbackEntries.push({ id, workspaceId: ws.id });
        await insertJob(id);
        await requests.bindGenerationRequest(claim, id);
        if (!(await reserve(id)))
          return Response.json({ id, status: "failed" }, { status: 409 });
        await measure("dispatch", () =>
          dispatch.dispatchRender(id, "image", async () => {
            // This is the only fake boundary. The two deliveries exercise the real permanent claim.
            await pause(2);
            await Promise.all([enterPaidBoundary(id), enterPaidBoundary(id)]);
          }),
        );
        await settle(id);
        return Response.json({ id, status: "succeeded" });
      };
      const responses = await measure("idempotent_request", () =>
        Promise.all([
          requests.withGenerationRequest(request(), user.id, callback),
          requests.withGenerationRequest(request(), user.id, callback),
        ]),
      );
      for (const response of responses)
        count(`request_status_${response.status}`);
      const failed = responses.find((response) => response.status >= 500);
      if (failed) throw new Error(`REQUEST_STATUS_${failed.status}`);
    }),
  );
}
async function draft(ws, marker) {
  return scoped(ws, async () => {
    const current = await measure("draft_read", () =>
      readDraft(user.id, `draft_${ws.id}`),
    );
    try {
      const saved = await measure("draft_save", () =>
        saveDraft(
          user.id,
          {
            ...current.project,
            script: `${current.project.script}${marker}\n`,
          },
          current.revision,
        ),
      );
      acknowledgedDrafts.push({
        workspaceId: ws.id,
        id: marker,
        revision: saved.revision,
      });
      count("acknowledged_draft_writes");
    } catch (error) {
      if (/another window|newer version/.test(error.message)) {
        count("expected_draft_conflicts");
        return;
      }
      throw error;
    }
  });
}
async function reconcile() {
  const invocation = `${workerIndex}:${sequence++}`;
  const result = await measure("reconciliation", () =>
    reconcileWorkspaces({
      client: platform.platformDb(),
      budgetMs: 2000,
      visit: async (workspaceId) => {
        const ws = workspaces.find((item) => item.id === workspaceId);
        if (!ws) throw new Error("UNEXPECTED_WORKSPACE");
        const observation = {
          invocation,
          worker: workerIndex,
          startedAtNs: process.hrtime.bigint().toString(),
          endedAtNs: null,
          owner: null,
        };
        leaseObservations.push(observation);
        try {
          const lease = (
            await platform
              .platformDb()
              .execute(
                "SELECT owner FROM operation_leases WHERE name='workspace-reconciliation'",
              )
          ).rows[0];
          observation.owner = String(lease.owner);
          const result = await scoped(ws, () =>
            settlements.flushGenerationSettlements(4),
          );
          return {
            failed: result.failed > 0,
            completed: result.attempted - result.failed,
          };
        } finally {
          observation.endedAtNs = process.hrtime.bigint().toString();
        }
      },
      cleanup: async () => ({ failed: 0 }),
    }),
  );
  count(
    result.skipped ? "reconciliation_lease_skips" : "reconciliation_lease_wins",
  );
  if (!result.ok) throw new Error("RECONCILIATION_FAILED");
}
async function workload(until) {
  const lanes =
    Math.floor(config.concurrency / config.processes) +
    (workerIndex < config.concurrency % config.processes ? 1 : 0);
  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      while (Date.now() < until) {
        const n = sequence++,
          shared = n % 5 === 0,
          ws =
            workspaces[
              shared ? 0 : (workerIndex + lane + n) % config.workspaces
            ],
          id = shared ? `gen_shared_${n}` : `gen_load_${workerIndex}_${n}`;
        for (const operation of [
          () => job(ws, id),
          () => draft(ws, `write_${workerIndex}_${n}`),
          ...(n % 4 === 0 ? [reconcile] : []),
        ]) {
          // Model separate arriving work items: do not starve event delivery timers
          // with an artificial microtask-only loop around the synchronous local driver.
          await new Promise(setImmediate);
          count("work_item_attempts");
          try {
            await operation();
          } catch (error) {
            unexpected(error);
          }
        }
      }
    }),
  );
}
function report(type) {
  process.send({
    type,
    samples,
    errors,
    counters,
    acknowledgedDrafts,
    paidEntries,
    callbackEntries,
    leaseObservations,
    blockedNetwork,
  });
  samples = {};
  errors = {};
  counters = {};
  acknowledgedDrafts = [];
  paidEntries = [];
  callbackEntries = [];
  leaseObservations = [];
  blockedNetwork = 0;
}
async function budget() {
  phase = "budget";
  const ws = workspaces.at(-1);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      scoped(ws, async () => {
        const id = `gen_budget_${workerIndex}_${i}`;
        count("work_item_attempts");
        try {
          await insertJob(id);
          await reserve(id);
        } catch (error) {
          unexpected(error);
        }
      }),
    ),
  );
}
async function verify() {
  const { paidEntryCoverage } = await import(
    pathToFileURL(path.join(__dirname, "load-rehearsal.mjs")).href
  );
  const actions = JSON.parse(
    fs.readFileSync(path.join(fixture, "observed-actions.json"), "utf8"),
  );
  const observations = {
    byWorkspace: [],
    draftAcknowledgments: 0,
    providerEntries: 0,
    requestCallbacks: 0,
    blockedNetworkAttempts: actions.blockedNetwork + blockedNetwork,
  };
  const invariants = {
    noOverdraw: true,
    noDoubleCharge: true,
    activeLimitRespected: true,
    noLostAcknowledgedDraftWrites: true,
    onePaidClaimPerJob: true,
    paidEntriesMatchSettledJobs: true,
    oneRequestCallbackPerKey: true,
    settlementsDrained: true,
    reconciliationNeverOverlaps: true,
    budgetBackpressureExercised: true,
    networkNeverUsed: actions.blockedNetwork + blockedNetwork === 0,
  };
  for (const ws of workspaces)
    await scoped(ws, async () => {
      if (ws.id === "ws_load_budget") {
        const admitted = (
          await platform.platformDb().execute({
            sql: "SELECT id FROM meter_events WHERE workspace_id=? AND status='running'",
            args: [ws.id],
          })
        ).rows;
        const expected = Math.floor(
          7 / billCredits(estimate, marginKeyOf(kind, model)),
        );
        invariants.budgetBackpressureExercised &&= admitted.length === expected;
        for (const row of admitted) {
          await enterPaidBoundary(String(row.id));
          await settle(String(row.id));
        }
      }
      await settlements.flushGenerationSettlements(50);
      const p = platform.platformDb(),
        state = await billingStateFor(ws.id);
      const billing = (
        await p.execute({
          sql: "SELECT COUNT(*) AS jobs,SUM(billed_credits) AS billed,SUM(status='running') AS running FROM meter_events WHERE workspace_id=?",
          args: [ws.id],
        })
      ).rows[0];
      const max = (
        await p.execute({
          sql: "SELECT MAX(active) AS active,MAX(billed) AS billed FROM load_observations WHERE workspace_id=?",
          args: [ws.id],
        })
      ).rows[0];
      const expectedCredit = billCredits(actual, marginKeyOf(kind, model));
      invariants.noOverdraw &&=
        state.credits.balance >= 0 &&
        Number(max.billed ?? 0) <= (ws.id === "ws_load_budget" ? 7 : 100000);
      invariants.activeLimitRespected &&=
        Number(max.active ?? 0) <= ws.concurrency;
      const charges = (
        await p.execute({
          sql: "SELECT id,status,billed_credits FROM meter_events WHERE workspace_id=?",
          args: [ws.id],
        })
      ).rows;
      invariants.noDoubleCharge &&=
        charges.every(
          (row) =>
            Number(row.billed_credits) ===
            (row.status === "succeeded"
              ? expectedCredit
              : billCredits(estimate, marginKeyOf(kind, model))),
        ) && state.credits.used === Number(billing.billed ?? 0);
      invariants.settlementsDrained &&=
        Number(billing.running ?? 0) === 0 &&
        Number(
          (
            await database
              .db()
              .execute(
                "SELECT COUNT(*) AS n FROM generation_settlements WHERE settled_at IS NULL",
              )
          ).rows[0].n,
        ) === 0;
      const callbacks = actions.callbackEntries.filter(
        (row) => row.workspaceId === ws.id,
      );
      const entries = [...actions.paidEntries, ...paidEntries].filter(
        (row) => row.workspaceId === ws.id,
      );
      observations.requestCallbacks += callbacks.length;
      observations.providerEntries += entries.length;
      invariants.oneRequestCallbackPerKey &&=
        new Set(callbacks.map((row) => row.id)).size === callbacks.length;
      invariants.onePaidClaimPerJob &&=
        new Set(entries.map((row) => row.id)).size === entries.length;
      const refusedJobs = (
        await database
          .db()
          .execute(
            "SELECT id FROM generations WHERE status='failed' AND error='Expected rehearsal backpressure'",
          )
      ).rows;
      invariants.paidEntriesMatchSettledJobs &&= paidEntryCoverage(
        charges,
        entries,
        refusedJobs.map((row) => String(row.id)),
      );
      const draft = await readDraft(user.id, `draft_${ws.id}`),
        acknowledgments = actions.acknowledgedDrafts.filter(
          (row) => row.workspaceId === ws.id,
        );
      observations.draftAcknowledgments += acknowledgments.length;
      const markers = new Set(draft.project.script.split("\n").filter(Boolean));
      invariants.noLostAcknowledgedDraftWrites &&=
        draft.revision >= acknowledgments.length + 1 &&
        acknowledgments.every(
          (row) =>
            markers.has(String(row.id)) && row.revision <= draft.revision,
        ) &&
        new Set(acknowledgments.map((row) => Number(row.revision))).size ===
          acknowledgments.length;
      observations.byWorkspace.push({
        workspace: ws.id,
        grants: state.credits.granted,
        billed: Number(billing.billed ?? 0),
        balance: state.credits.balance,
        jobs: Number(billing.jobs),
        maxActive: Number(max.active ?? 0),
        configuredActiveLimit: ws.concurrency,
      });
    });
  // hrtime is a host-wide monotonic clock, shared by these local Node processes.
  // Compare actual visit work intervals, not an audit table that could retain rows after a failed cleanup.
  const visits = [...actions.leaseObservations].sort((a, b) =>
    BigInt(a.startedAtNs) < BigInt(b.startedAtNs) ? -1 : 1,
  );
  let latestEnd = 0n;
  for (const visit of visits) {
    if (!visit.endedAtNs || BigInt(visit.startedAtNs) < latestEnd)
      invariants.reconciliationNeverOverlaps = false;
    if (visit.endedAtNs && BigInt(visit.endedAtNs) > latestEnd)
      latestEnd = BigInt(visit.endedAtNs);
  }
  const owners = new Map();
  for (const observation of actions.leaseObservations.filter(
    (item) => item.owner,
  )) {
    if (!owners.has(observation.owner))
      owners.set(observation.owner, observation.worker);
    else if (owners.get(observation.owner) !== observation.worker)
      invariants.reconciliationNeverOverlaps = false;
  }
  observations.reconciliationOwners = owners.size;
  observations.reconciliationVisits = visits.length;
  process.send({ type: "verified", invariants, observations });
}
(async () => {
  await initialize(mode === "setup");
  if (mode === "verify") return verify();
  process.send({ type: "ready" });
  if (mode === "worker")
    process.on("message", async (message) => {
      try {
        if (message.type === "start") {
          await workload(message.until);
          report("completed");
        } else if (message.type === "budget") {
          await budget();
          report("budget-completed");
        }
      } catch (error) {
        process.send({ type: "fatal", code: errorCode(error) });
      }
    });
})().catch((error) => {
  process.send({ type: "fatal", code: errorCode(error) });
});
