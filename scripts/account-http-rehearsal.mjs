import { RecoveryFence, RECOVERY_PROTOCOL } from "../lib/recovery/control.mjs";
/** Local-only full HTTP rehearsal. No Stripe validation or external provider calls. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { request } from "@playwright/test";
import { verifyUploadHttp } from "./upload-http-checks.mjs";

if (process.env.VERCEL || process.env.NODE_ENV === "production")
  throw new Error("Local rehearsal only");
const root = process.cwd(),
  dir = mkdtempSync(path.join(tmpdir(), "particl-http-"));
const projectDir = path.join(dir, "project");
mkdirSync(projectDir, { recursive: true });
for (const name of ["app", "components", "lib", "public"])
  cpSync(path.join(root, name), path.join(projectDir, name), {
    recursive: true,
  });
symlinkSync(
  path.join(root, "node_modules"),
  path.join(projectDir, "node_modules"),
  "dir",
);
for (const name of ["package.json", "tsconfig.json", "postcss.config.mjs"])
  if (existsSync(path.join(root, name)))
    copyFileSync(path.join(root, name), path.join(projectDir, name));
writeFileSync(path.join(projectDir, "next.config.mjs"), "export default {};\n");
// Next loads local env files itself. Shadow every configured value before it can
// do so; the entire test must use disposable local resources and placeholder keys.
for (const file of readdirSync(root).filter((f) => /^\.env(?:\.|$)/.test(f)))
  if (existsSync(path.join(root, file))) {
    for (const line of readFileSync(path.join(root, file), "utf8").split(
      "\n",
    )) {
      const key = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/)?.[1];
      if (key) process.env[key] = "";
    }
  }
Object.assign(process.env, {
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  ENGINE_MOCK: "1",
  PLATFORM_DATABASE_URL: `file:${path.join(dir, "platform.db")}`,
  TURSO_DATABASE_URL: `file:${path.join(dir, "primary.db")}`,
  PLATFORM_AUTH_TOKEN: "",
  TURSO_AUTH_TOKEN: "",
  TURSO_API_TOKEN: "",
  TURSO_ORG: "",
  WORKSPACE_DB_DIRECTORY: path.join(dir, "tenants"),
  KEYRING_SECRET: "local-account-http-rehearsal-secret-32-characters",
  PLATFORM_KEYS_FOR_NEW_WORKSPACES: "1",
  RESEND_API_KEY: "local-mail-placeholder",
  MAIL_FROM: "Particl <test@example.test>",
  PAYMENT_PROVIDER: "stripe",
  STRIPE_SECRET_KEY: "sk_test_local_placeholder_not_a_credential",
  STRIPE_WEBHOOK_SECRET: "whsec_local_placeholder",
  VERCEL_ENV: "development",
  BLOB_READ_WRITE_TOKEN: "",
  INNGEST_EVENT_KEY: "",
  INNGEST_SIGNING_KEY: "",
});
const realFetch = globalThis.fetch;
const blockedHosts = [];
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    blockedHosts.push(url.hostname);
    throw new Error("Rehearsal blocked an external request");
  }
  return realFetch(input, init);
};
const mail = [];
const sink = createServer(async (req, res) => {
  let text = "";
  for await (const part of req) text += part;
  mail.push(JSON.parse(text));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ id: "local-mail-" + mail.length }));
});
await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
process.env.RESEND_BASE_URL = `http://127.0.0.1:${sink.address().port}`;
let handle;
const server = createServer((req, res) => handle(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.APP_ORIGIN = base;
// Local storage paths must remain inside the disposable application too.
process.chdir(projectDir);
const { default: next } = await import("next");
const app = next({
  dev: true,
  dir: projectDir,
  webpack: true,
  hostname: "127.0.0.1",
  port: server.address().port,
  httpServer: server,
});
handle = app.getRequestHandler();
const contexts = [];
const context = async (headers = {}) => {
  const api = await request.newContext({
    baseURL: base,
    extraHTTPHeaders: headers,
  });
  contexts.push(api);
  return api;
};
const p = createClient({ url: process.env.PLATFORM_DATABASE_URL });
let code = 0;
const password = "Local account HTTP passphrase 43";
const body = {
  name: "Customer",
  email: "customer@example.test",
  workspace: "Customer house",
  password,
  accept: true,
  planId: "agency",
  cadence: "annual",
};
async function json(response, status) {
  assert.equal(
    response.status(),
    status,
    (await response.text()).slice(0, 300),
  );
  return response.json();
}
const proof = () =>
  new URL(mail.at(-1).text.match(/http:\/\/\S+/)[0]).searchParams.get("verify");
try {
  await app.prepare();
  const api = await context();
  assert.equal((await json(await api.get("/api/health"), 200)).mock, true);
  assert.equal((await json(await api.get("/api/auth/signup"), 200)).open, true);
  await json(await api.post("/api/auth/signup", { data: body }), 202);
  assert.equal(mail.length, 1);
  assert.equal(
    (
      await p.execute(
        `SELECT id FROM accounts WHERE email='customer@example.test'`,
      )
    ).rows.length,
    0,
  );
  const oldProof = proof();
  await json(
    await api.post("/api/auth/signup/resend", { data: { email: body.email } }),
    429,
  );
  // Advance only the one-minute cooldown in the local fixture instead of sleeping.
  await p.execute(
    `DELETE FROM account_action_limits WHERE key LIKE 'signup-email-minute:%'`,
  );
  await json(
    await api.post("/api/auth/signup/resend", { data: { email: body.email } }),
    202,
  );
  assert.equal(mail.length, 2);
  assert.notEqual(proof(), oldProof);
  await json(
    await api.post("/api/auth/verify", { data: { token: oldProof } }),
    410,
  );
  const verified = await json(
    await api.post("/api/auth/verify", { data: { token: proof() } }),
    200,
  );
  assert.equal(
    verified.next,
    "/billing?plan=agency&cadence=annual&onboarding=1",
  );
  const first = verified.workspace;
  const mine = await json(await api.get("/api/workspaces"), 200);
  assert.equal(mine.active, first.id);
  const ownerId = String(
    (
      await p.execute(
        "SELECT id FROM accounts WHERE email='customer@example.test'",
      )
    ).rows[0].id,
  );
  const ownerHeaders = {
    "X-Workbench-Scope": `particl-active-${first.id}-${ownerId}`,
  };
  assert.equal(mine.workspaces.length, 1);
  assert.equal(
    (
      await p.execute({
        sql: "SELECT * FROM credit_grants WHERE workspace_id=?",
        args: [first.id],
      })
    ).rows.length,
    0,
  );
  assert.equal(
    (
      await p.execute({
        sql: "SELECT plan_id FROM workspaces WHERE id=?",
        args: [first.id],
      })
    ).rows[0].plan_id,
    "invite",
  );
  await json(
    await api.patch("/api/workspaces", {
      headers: ownerHeaders,
      data: { name: "Customer renamed" },
    }),
    200,
  );
  await json(
    await api.post("/api/workspaces", {
      headers: { Origin: "https://different.example" },
      data: { name: "Cross-origin" },
    }),
    403,
  );
  const token = await json(
    await api.post("/api/tokens", {
      headers: ownerHeaders,
      data: { name: "Read only", scope: "read" },
    }),
    200,
  );
  const read = await context({ Authorization: `Bearer ${token.token}` });
  await json(await read.get("/api/projects"), 200);
  await json(
    await read.post("/api/projects", { data: { name: "Forbidden" } }),
    403,
  );
  await json(
    await read.post("/api/team", {
      data: { email: "forbidden@example.test", name: "No" },
    }),
    403,
  );
  assert.ok(
    (
      await json(
        await read.post("/api/mcp", {
          data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        }),
        200,
      )
    ).result.tools.length,
  );
  assert.equal(
    (
      await json(
        await read.post("/api/mcp", {
          data: {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "list_projects", arguments: {} },
          },
        }),
        200,
      )
    ).result.isError,
    undefined,
  );
  assert.equal(
    (
      await json(
        await read.post("/api/mcp", {
          data: {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "create_project",
              arguments: { name: "Forbidden" },
            },
          },
        }),
        200,
      )
    ).result.isError,
    true,
  );
  for (const endpoint of [
    "login",
    "logout",
    "setup",
    "reset",
    "reset/invalid-token",
  ]) {
    await json(
      await api.post("/api/auth/" + endpoint, {
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "text/plain",
        },
        data: JSON.stringify({ email: "attacker@example.test", password }),
      }),
      403,
    );
  }
  assert.equal(
    (await json(await api.get("/api/workspaces"), 200)).active,
    first.id,
  );
  await verifyUploadHttp({
    api,
    context,
    platform: p,
    json,
    workspaceId: first.id,
    email: body.email,
  });
  // Zero-grant customers cannot render before funding. A local ledger fixture,
  // not a checkout or provider payment, then exercises the real mock render path.
  const project = await json(
    await api.post("/api/projects", { data: { name: "First production" } }),
    200,
  );
  const generation = {
    prompt: "A red sphere.",
    model: "dreamina-seedance-2-5-260628",
    ratio: "16:9",
    resolution: "1080p",
    duration: 5,
    generateAudio: true,
    watermark: false,
    seed: null,
    projectId: project.id,
    task: "generate",
    sourceGenId: null,
    references: [],
  };
  const pristine = createClient({
    url: String(
      (
        await p.execute({
          sql: "SELECT db_url FROM workspaces WHERE id=?",
          args: [first.id],
        })
      ).rows[0].db_url,
    ),
  });
  await json(
    await api.post("/api/generate", {
      headers: {
        "Idempotency-Key": "http-stale-actor",
        "X-Actor-Email": "different-account@example.test",
        "X-Workspace-Id": first.id,
      },
      data: generation,
    }),
    409,
  );
  assert.equal(
    Number(
      (await pristine.execute("SELECT COUNT(*) AS n FROM generations")).rows[0]
        .n,
    ),
    0,
  );
  assert.equal(
    (
      await p.execute({
        sql: "SELECT id FROM meter_events WHERE workspace_id=?",
        args: [first.id],
      })
    ).rows.length,
    0,
  );
  pristine.close();
  const held = await json(
    await api.post("/api/generate", {
      headers: {
        "Idempotency-Key": "http-no-credits",
        "X-Actor-Email": body.email,
        "X-Workspace-Id": first.id,
      },
      data: generation,
    }),
    202,
  );
  assert.equal(held.status, "held");
  assert.equal(held.held, true);
  assert.equal(
    (
      await p.execute({
        sql: "SELECT id FROM meter_events WHERE id=?",
        args: [held.id],
      })
    ).rows.length,
    0,
  );
  await p.execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_at) VALUES('local-http-funding',?,250,'Disposable local rehearsal fixture','manual',?)",
    args: [first.id, Date.now()],
  });
  const started = await json(
    await api.post("/api/generate", {
      headers: {
        "Idempotency-Key": "http-funded-render",
        "X-Actor-Email": body.email,
        "X-Workspace-Id": first.id,
      },
      data: generation,
    }),
    200,
  );
  let job;
  for (let i = 0; i < 30; i++) {
    job = (await json(await api.get("/api/jobs/" + started.id), 200))
      .generation;
    if (["succeeded", "failed"].includes(job?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(
    job?.status,
    "succeeded",
    job?.error ?? "first mock render did not finish",
  );
  assert.equal(
    (
      await p.execute({
        sql: "SELECT id FROM meter_events WHERE workspace_id=? AND kind='text'",
        args: [first.id],
      })
    ).rows.length,
    0,
  );
  const tenantDb = createClient({
    url: String(
      (
        await p.execute({
          sql: "SELECT db_url FROM workspaces WHERE id=?",
          args: [first.id],
        })
      ).rows[0].db_url,
    ),
  });
  const savedJob = (
    await tenantDb.execute({
      sql: "SELECT refine_cost_usd,refine_ms FROM generations WHERE id=?",
      args: [started.id],
    })
  ).rows[0];
  assert.equal(savedJob.refine_cost_usd, null);
  assert.equal(savedJob.refine_ms, null);
  tenantDb.close();
  const repeat = await json(
    await api.post("/api/generate", {
      headers: {
        "Idempotency-Key": "http-funded-render",
        "X-Actor-Email": body.email,
        "X-Workspace-Id": first.id,
      },
      data: generation,
    }),
    200,
  );
  assert.equal(repeat.id, started.id);
  // Authoritative text/training bills and another tenant's sentinel verify
  // Usage does not recompute charges or disclose provider accounting.
  const actorId = String(
    (
      await p.execute(
        "SELECT id FROM accounts WHERE email='customer@example.test'",
      )
    ).rows[0].id,
  );
  for (const [id, workspaceId, kind, model, credits, rawCost] of [
    ["http-text-meter", first.id, "text", "mock-visible-text", 7, 123456],
    [
      "http-training-meter",
      first.id,
      "training",
      "mock-visible-training",
      11,
      234567,
    ],
    [
      "http-outsider-meter",
      "another-usage-workspace",
      "text",
      "CROSS-WORKSPACE-SENTINEL",
      999,
      345678,
    ],
  ])
    await p.execute({
      sql: "INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'succeeded',?,?,1,?,?,?)",
      args: [
        id,
        workspaceId,
        project.id,
        kind,
        kind === "training" ? "fal" : "vercel",
        model,
        rawCost,
        credits,
        actorId,
        Date.now(),
        Date.now(),
      ],
    });
  const privacyDb = createClient({
    url: String(
      (
        await p.execute({
          sql: "SELECT db_url FROM workspaces WHERE id=?",
          args: [first.id],
        })
      ).rows[0].db_url,
    ),
  });
  await privacyDb.execute({
    sql: "UPDATE generations SET params=json_set(params,'$.paidClaim','PRIVATE-CLAIM','$.producedOutcome','PRIVATE-OUTCOME') WHERE id=?",
    args: [started.id],
  });
  privacyDb.close();
  const expectedCredits = Number(
    (
      await p.execute({
        sql: "SELECT SUM(billed_credits) AS n FROM meter_events WHERE workspace_id=? AND paid_by_platform=1",
        args: [first.id],
      })
    ).rows[0].n,
  );
  const usage = await json(await api.get("/api/usage"), 200);
  const summary = await json(await api.get("/api/usage/summary"), 200);
  for (const view of [usage, summary]) {
    assert.equal(view.spentCredits, expectedCredits);
    assert.equal(view.credits.used, expectedCredits);
    assert.ok(
      view.vendors.every((v) => Object.keys(v).sort().join(",") === "id,label"),
    );
    const serialized = JSON.stringify(view);
    assert.ok(
      !/paidClaim|producedOutcome|PRIVATE-|CROSS-WORKSPACE|engine_cost_usd|[Cc]ostUsd|balanceUsd|usedUsd|spentUsd|purchasedUsd|envKey/.test(
        serialized,
      ),
    );
  }
  assert.equal(
    usage.byModel.find((row) => row.model === "mock-visible-text").credits,
    7,
  );
  assert.equal(
    usage.byModel.find((row) => row.model === "mock-visible-training").credits,
    11,
  );
  assert.equal(
    usage.recent.find((row) => row.id === started.id).params.ratio,
    "16:9",
  );
  const mcpUsage = await json(
    await read.post("/api/mcp", {
      data: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "usage_summary", arguments: {} },
      },
    }),
    200,
  );
  assert.ok(mcpUsage.result.content[0].text.includes(`${expectedCredits} cr`));
  assert.ok(!mcpUsage.result.content[0].text.includes("$"));
  const team = await json(
    await api.post("/api/team", {
      headers: ownerHeaders,
      data: { email: "teammate@example.test", name: "Teammate", send: true },
    }),
    200,
  );
  assert.equal(team.sent, true);
  assert.ok(
    mail.some((message) => message.to.includes("teammate@example.test")),
  );
  const member = await context();
  assert.equal(
    (await json(await member.get("/api/auth/accept?code=" + team.code), 200))
      .hasAccount,
    false,
  );
  await json(
    await member.post("/api/auth/accept", {
      data: { code: team.code, password, name: "Teammate" },
    }),
    200,
  );
  assert.equal(
    (await json(await member.get("/api/workspaces"), 200)).active,
    first.id,
  );
  const memberScopeId = String(
    (
      await p.execute(
        "SELECT id FROM accounts WHERE email='teammate@example.test'",
      )
    ).rows[0].id,
  );
  const memberToken = await json(
    await member.post("/api/tokens", {
      headers: {
        "X-Workbench-Scope": `particl-active-${first.id}-${memberScopeId}`,
      },
      data: { name: "Team read", scope: "read" },
    }),
    200,
  );
  const memberRead = await context({
    Authorization: `Bearer ${memberToken.token}`,
  });
  await json(await memberRead.get("/api/projects"), 200);
  const memberId = String(
    (
      await p.execute(
        `SELECT id FROM accounts WHERE email='teammate@example.test'`,
      )
    ).rows[0].id,
  );
  await json(
    await api.patch("/api/team/" + memberId, {
      headers: ownerHeaders,
      data: { disabled: true },
    }),
    200,
  );
  await json(await memberRead.get("/api/projects"), 401);
  assert.equal(
    (await json(await member.get("/api/workspaces"), 401)).error,
    "Not signed in",
  );
  await json(
    await api.patch("/api/team/" + memberId, {
      headers: ownerHeaders,
      data: { disabled: false },
    }),
    200,
  );
  await json(
    await member.post("/api/auth/login", {
      data: { email: "teammate@example.test", password },
    }),
    200,
  );
  assert.equal(
    (await json(await member.get("/api/workspaces"), 200)).active,
    first.id,
  );
  // Two simultaneous accepts compete for the one remaining Invite seat.
  const invitations = await Promise.all(
    ["a", "b"].map(async (suffix) =>
      json(
        await api.post("/api/team", {
          headers: ownerHeaders,
          data: {
            email: `concurrent-${suffix}@example.test`,
            name: "Concurrent " + suffix,
            send: false,
          },
        }),
        200,
      ),
    ),
  );
  const invitees = await Promise.all([context(), context()]);
  const accepted = await Promise.all(
    invitees.map((invitee, i) =>
      invitee.post("/api/auth/accept", {
        data: { code: invitations[i].code, password },
      }),
    ),
  );
  assert.deepEqual(accepted.map((r) => r.status()).sort(), [200, 402]);
  // The existing-account create route creates an independent empty, zero-grant room.
  const second = (
    await json(
      await api.post("/api/workspaces", {
        headers: ownerHeaders,
        data: { name: "Second customer house" },
      }),
      201,
    )
  ).workspace;
  assert.notEqual(second.id, first.id);
  // Creation selected the new room; subsequent requests capture that context.
  const secondHeaders = {
    "X-Workbench-Scope": `particl-active-${second.id}-${ownerId}`,
  };
  const replay = (
    await json(
      await api.post("/api/workspaces", {
        headers: secondHeaders,
        data: { name: "Second customer house" },
      }),
      201,
    )
  ).workspace;
  assert.equal(replay.id, second.id);
  assert.equal(
    (await json(await api.get("/api/workspaces"), 200)).workspaces.length,
    2,
  );
  assert.equal(
    (
      await p.execute({
        sql: "SELECT * FROM credit_grants WHERE workspace_id=?",
        args: [second.id],
      })
    ).rows.length,
    0,
  );
  await json(
    await api.post("/api/workspaces/switch", {
      headers: secondHeaders,
      data: { id: first.id },
    }),
    200,
  );
  assert.equal(
    (await json(await api.get("/api/workspaces"), 200)).active,
    first.id,
  );
  // Reset is a real routed cookie transition, with mail delivered only to this sink.
  await json(
    await api.post("/api/auth/reset", { data: { email: body.email } }),
    200,
  );
  let resetToken;
  for (let attempt = 0; attempt < 100 && !resetToken; attempt++) {
    resetToken = mail
      .flatMap((message) =>
        [
          ...String(message.text).matchAll(
            /http:\/\/[^\s]+\/reset\/([A-Za-z0-9_-]+)/g,
          ),
        ].map((match) => match[1]),
      )
      .at(-1);
    if (!resetToken) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resetToken, "Password reset stayed in the local mail sink");
  const resetBrowser = await context();
  const nextPassword = "Reset local HTTP passphrase 44";
  await json(
    await resetBrowser.post("/api/auth/reset/" + resetToken, {
      data: { password: nextPassword },
    }),
    200,
  );
  await json(await api.get("/api/workspaces"), 401);
  assert.equal(
    (await json(await resetBrowser.get("/api/workspaces"), 200)).active,
    first.id,
  );
  await json(
    await resetBrowser.post("/api/auth/reset/" + resetToken, {
      data: { password: nextPassword },
    }),
    410,
  );
  console.log(
    "PASS: HTTP password reset spends its link, revokes prior session cookies and creates a working new session.",
  );
  const fence = new RecoveryFence(p, "local-http-coordinator");
  const coordinator = "local-http-maintenance-owner-0123456789";
  const epoch = await fence.begin(coordinator, {
    deployments: [{ id: "local", protocol: RECOVERY_PROTOCOL }],
    oldDeploymentsStopped: true, externalWritersExcluded: true,
    evidence: "Disposable local HTTP fixture; network guard excludes every remote provider and database.",
  });
  const countsBefore = (await p.execute("SELECT (SELECT COUNT(*) FROM accounts) AS accounts,(SELECT COUNT(*) FROM workspaces) AS workspaces,(SELECT COUNT(*) FROM p_sessions) AS sessions")).rows[0];
  await json(await resetBrowser.patch("/api/settings", {headers:{"X-Workbench-Scope": `particl-active-${first.id}-${ownerId}`},data:{defaultProject:"forbidden"}}), 503);
  await json(await resetBrowser.post("/api/workspaces", {headers:{"X-Workbench-Scope": `particl-active-${first.id}-${ownerId}`},data:{name:"Forbidden during maintenance"}}), 503);
  await json(await resetBrowser.post("/api/auth/logout", {headers:{"X-Workbench-Scope": `particl-active-${first.id}-${ownerId}`}}), 503);
  await json(await resetBrowser.post("/api/auth/signup", {data:{...body,email:"blocked@example.test"}}), 503);
  assert.deepEqual((await p.execute("SELECT (SELECT COUNT(*) FROM accounts) AS accounts,(SELECT COUNT(*) FROM workspaces) AS workspaces,(SELECT COUNT(*) FROM p_sessions) AS sessions")).rows[0],countsBefore);
  await fence.reopen(coordinator, epoch.epoch);
  assert.equal((await json(await resetBrowser.get("/api/workspaces"),200)).active,first.id);
  console.log("PASS: enforced maintenance rejects actual routed settings, workspace creation, logout and signup before mutation; explicit reopen preserves the session.");
  // Next dev checks its latest npm version. That framework request is also
  // blocked; any attempted provider request still fails this rehearsal.
  assert.equal(
    blockedHosts.filter((host) => host !== "registry.npmjs.org").length,
    0,
    "Unexpected external request attempt: " + blockedHosts.join(","),
  );
  console.log(
    "PASS: real HTTP signup/resend/verification/session/provisioning/team acceptance/revocation/rename/workspace creation and MCP read scope. The unfunded render was held without a paid submission; after local fixture funding the first mock render completed and its retry reused the same job. Mail stayed in the local sink; no checkout or external provider was called.",
  );
} catch (error) {
  code = 1;
  console.error(error);
} finally {
  await Promise.all(contexts.map((api) => api.dispose()));
  p.close();
  await app.close();
  server.closeAllConnections();
  sink.closeAllConnections();
  server.close();
  sink.close();
  process.exit(code);
}
