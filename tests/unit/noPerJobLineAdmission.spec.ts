import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { keepingHouseJobsClean } from "../helpers/houseJobs";
import type {
  AdmissionActor,
} from "../../lib/admissionTypes";

import type { TenantWorkspace } from "../../lib/tenant";

/**
 * No per-job line, through admission (owner, 20 Oct 2026: "Guardrail 4 is retired everywhere, single jobs included: no per-job line in the
 * product. Every job is approved on its quote before it runs; the only automatic stop is the workspace's monthly spend limit with Paused.").
 * This file pinned guardrail 4 (a job over 200 cr needed an admin's own tap; a token was refused outright). It now pins its retirement: a job
 * priced far over 200 cr is quoted and admitted like any other, at the quote route, the prepared admission and the press, for a member, an
 * admin, a token and the house, single takes and presses of several; and the press still carries the person's approval of its quote
 * (`maxCredits`), so a press whose approval is under the quote is refused and nothing is created. Mocked engines; nothing is spent.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-no-per-job-line-admission-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const person = (id: string, role: "admin" | "member"): AdmissionActor => ({ user: { id, email: `${id}@example.invalid`, name: id, role, owner: role === "admin", disabled: false, createdAt: 0, lastSeen: null } });
const admin = person("owner", "admin"), member = person("u_member", "member");
let actor: AdmissionActor = admin;
const nodeRequire = createRequire(path.resolve("package.json"));
let dispatched: { genId: string; kind: string }[] = [];
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/")
        ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
        : name.startsWith(".")
          ? nodeRequire(path.resolve(path.dirname(file), name + ".ts"))
          : nodeRequire(name);
    },
    target,
    target.exports,
  );
  return target.exports as T;
}
function services() {
  const queue = {
    enqueueRender: async (genId: string, kind: string) => {
      dispatched.push({ genId, kind });
      return true;
    },
  };
  return {
    gen: load<typeof import("../../lib/generationAdmission")>(
      "lib/generationAdmission.ts",
      { "@/lib/inngest": queue },
    ),
    audio: load<typeof import("../../lib/audioAdmission")>(
      "lib/audioAdmission.ts",
      { "@/lib/inngest": queue },
    ),
  };
}
async function scope(
  name: string,
  fn: (loaded: ReturnType<typeof services>) => Promise<void>,
  id = name,
  who: AdmissionActor = admin,
) {
  actor = who;
  const { platformReady, platformDb, rowToWorkspace, grantCredits } =
    await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  /* The house's id is fixed (ws_legacy) and other specs in this worker make its row themselves (platformOwnerPrivacy), so the house here is a scope built in
     this file and never a workspaces, memberships or credit row left behind in the shared platform database. */
  let ws: TenantWorkspace;
  if (id === "ws_legacy") {
    ws = { id, slug: "house", name: "House", legacy: true, dbUrl: `file:${path.join(dir, name + ".db")}`, dbToken: null, keys: {}, usesPlatformKeys: false, allowanceUsd: null,
      gatewayKeyId: null, ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 1000, rendersPerHour: 100_000,
      storageQuotaBytes: null, deletedAt: null };
  } else {
    await platformDb().execute({
      sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
      args: [id, name, name, `file:${path.join(dir, name + ".db")}`],
    });
    await grantCredits(id, 10000, "Test", "owner", "manual");
    for (const [account, role] of [["owner", "owner"], ["u_member", "member"]] as const)
      await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [id, account, role] });
    ws = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [id] })).rows[0]);
  }
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network forbidden in admission parity test");
  };
  dispatched = [];
  try {
    await runInTenant(
      ws,
      async () => {
        await ready();
        /* The house's id is fixed (ws_legacy), so another spec in this worker may have booted its own database under that id and left this one's request table unmade. */
        await db().execute(`CREATE TABLE IF NOT EXISTS generation_requests (
          user_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, generation_id TEXT, response_json TEXT, response_status INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, request_key))`);
        await db().execute(
          "INSERT OR IGNORE INTO projects(id,name,created_at) VALUES('project','Project',0)",
        );
        await db().execute(
          "INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'",
        );
        await fn(services());
      },
      who,
    );
  } finally {
    globalThis.fetch = fetch;
  }
}
const noInline = () => {
  throw new Error("Durable dispatch acknowledged; inline work must not run");
};

async function rows() {
  const { db } = await import("../../lib/db");
  return (await db().execute("SELECT * FROM generations ORDER BY id")).rows;
}
async function meters() {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (
    await platformDb().execute({
      sql: "SELECT * FROM meter_events WHERE workspace_id=?",
      args: [requireTenant().id],
    })
  ).rows;
}
function route(
  kind: "generation" | "audio",
  service: ReturnType<typeof services>,
) {
  const file =
    kind === "generation"
      ? "app/api/generate/route.ts"
      : "app/api/audio/route.ts";
  return load<{ POST(req: Request): Promise<Response> }>(file, {
    "@/lib/auth": {
      withTenant: (handler: unknown) => handler,
      requireRender: async () => actor,
    },
    "@/lib/generationAdmission": service.gen,
    "@/lib/audioAdmission": service.audio,
    "next/server": { NextResponse: Response, after: noInline },
  });
}
function request(kind: string, body: unknown, key: string) {
  return new Request(`http://localhost/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}


/** The quote route, as the browser calls it: the same prepare as admission, stopped before anything is reserved. */
function quoteRoute(service: ReturnType<typeof services>) {
  return load<{ POST(req: Request): Promise<Response> }>("app/api/generate/quote/route.ts", {
    "@/lib/auth": { withTenant: (handler: unknown) => handler, requireRender: async () => actor },
    "@/lib/generationAdmission": service.gen,
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
  });
}
const quoteRequest = (body: unknown) => new Request("http://localhost/api/generate/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* Cinema Studio 4.0 at 720p, 30 s: about 209 cr (its hold is more); at 480p, 30 s: about 94 cr, whose hold (3 ×) is over 200 cr. A Grok clip is far under. */
const OVER = { model: "higgsfield-cinema-studio-4.0", prompt: "A tree in rain", projectId: "project", ratio: "16:9", resolution: "720p", duration: 30 };
const HELD_OVER = { ...OVER, resolution: "480p" };
const UNDER = { model: "grok-imagine-video", prompt: "A tree in rain", projectId: "project", ratio: "16:9", resolution: "720p", duration: 5 };

/* The press carries the ceiling its price was approved at (Cinema Studio's is approximate, so it must). */
const press = (service: ReturnType<typeof services>, body: Record<string, unknown>, key: string, maxCredits = 5000) => route("generation", service).POST(request("generation", { ...body, maxCredits }, key));
const counts = async () => [(await rows()).length, (await meters()).length];

test("through admission and the quote route: a member's job over 200 cr (at its estimate, and at its hold) is quoted and admitted like any other; no 403, no needsAdmin", async () =>
  scope("npl-line", async (service) => {
    const quote = quoteRoute(service);
    for (const [label, body] of [["its estimate", OVER], ["its hold", HELD_OVER]] as const) {
      /* The free quote, the prepared admission and the press: no per-job line answers, and the press is admitted and reserved. */
      const q = await quote.POST(quoteRequest(body));
      const answer = await q.clone().json();
      expect(q.status, `${label}: ${JSON.stringify(answer)}`).toBe(200);
      expect(answer.needsAdmin, label).toBeUndefined();
      expect(Math.max(Number(answer.estimatedCredits), Number(answer.ceilingCredits ?? 0)), `${label}: priced over the old 200 cr line`).toBeGreaterThan(200);
      expect(await service.gen.prepareGeneration(body, actor), label).toMatchObject({ ok: true });
      const before = await counts();
      const pressed = await press(service, body, `npl-member-${label.replace(/\W+/g, "-")}`);
      expect(pressed.status, `${label}: ${JSON.stringify(await pressed.clone().json())}`).toBeLessThan(300);
      expect(await counts(), `${label}: one take created, one job reserved`).toEqual([before[0] + 1, before[1] + 1]);
    }
    /* Under 200 cr nothing changes, for the member too. */
    const small = await quote.POST(quoteRequest(UNDER));
    expect(small.status).toBe(200);
  }, "npl-line", member));

test("every job is approved on its quote: a press whose approval (maxCredits) is under the quote is refused, whatever its size, and nothing is created", async () =>
  scope("npl-approval", async (service) => {
    const q = await (await quoteRoute(service).POST(quoteRequest(OVER))).json();
    const quoted = Number(q.ceilingCredits ?? q.estimatedCredits);
    expect(quoted).toBeGreaterThan(200);
    const before = await counts();
    const short = await press(service, OVER, "npl-short-approval", Math.floor(quoted) - 50);
    expect(short.status, JSON.stringify(await short.clone().json())).toBe(409);
    expect(String((await short.json()).error)).toMatch(/Review the updated credit quote/);
    expect(await counts(), "nothing created, nothing reserved").toEqual(before);
  }, "npl-approval", member));

test("through admission: an admin's own tap is admitted as before; a token with an admin's identity is quoted (no per-job line) but still cannot approve a held take: only a person approves a hold", async () => {
  await scope("npl-line", async (service) => {
    const ok = await quoteRoute(service).POST(quoteRequest(OVER));
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    expect((await ok.json()).estimatedCredits).toBeGreaterThan(200);
    const made = await press(service, OVER, "npl-admin");
    expect(made.status, JSON.stringify(await made.clone().json())).toBeLessThan(300);
  }, "npl-line", admin);
  await scope("npl-line", async (service) => {
    const viaToken = await quoteRoute(service).POST(quoteRequest(OVER));
    expect(viaToken.status, JSON.stringify(await viaToken.clone().json())).toBe(200);
    expect((await viaToken.json()).needsAdmin).toBeUndefined();
    /* A machine can prepare it, never approve its hold (people only, unchanged): refused for that, not for its size, and nothing is created. */
    const before = await counts();
    const made = await press(service, OVER, "npl-token");
    const said = await made.clone().json();
    expect(made.status, JSON.stringify(said)).toBe(403);
    expect(said).toMatchObject({ error: expect.stringMatching(/Only a person signed in to Particl approves/) });
    expect(said.needsAdmin).toBeUndefined();
    expect(await counts()).toEqual(before);
  }, "npl-line", { ...admin, token: { id: "tok_npl", name: "agent", scope: "render", capUsd: null } } as AdmissionActor);
});

/* The house pays no credits; its job over the old line at cost (this clip's hold: 3 × its ~$14 estimate) is quoted in dollars and admitted, for a member and a token too.
   Its own monthly cap (lib/houseCap.ts) is what stops the house, and is unchanged (tests/unit/houseCap.spec.ts). */
test("the house: a member's and an admin's job over the old line at cost is quoted and admitted, a token's quoted (its hold still a person's to approve); under it nothing changes", async () => {
  await keepingHouseJobsClean(async () => {
    for (const [who, label] of [[member, "member"], [admin, "admin"], [{ ...admin, token: { id: "tok_nplh", name: "agent", scope: "render", capUsd: null } } as AdmissionActor, "token"]] as const) {
      await scope("npl-house", async (service) => {
        const q = await quoteRoute(service).POST(quoteRequest(OVER));
        const answer = await q.clone().json();
        expect(q.status, `${label}: ${JSON.stringify(answer)}`).toBe(200);
        expect(answer.unit, label).toBe("usd");
        expect(answer.needsAdmin, label).toBeUndefined();
        const before = await counts();
        const made = await press(service, OVER, `npl-house-${label}`);
        const said = await made.clone().json();
        if (label === "token") {
          expect(made.status, `${label}: ${JSON.stringify(said)}`).toBe(403);
          expect(String(said.error)).toMatch(/Only a person signed in to Particl approves/);
          expect(await counts(), label).toEqual(before);
        } else {
          expect(made.status, `${label}: ${JSON.stringify(said)}`).toBeLessThan(300);
          expect(await counts(), label).toEqual([before[0] + 1, before[1] + 1]);
        }
        expect((await quoteRoute(service).POST(quoteRequest(UNDER))).status, label).toBe(200);
      }, "ws_legacy", who);
    }
  });
});

/* A press of several: Seedance 2.0 at 1080p for 10 s is 57 cr a take, so a press of 4 is 228 cr in all. Each take is its own job at its own quote; nothing adds them up. */
const TAKE = { model: "dreamina-seedance-2-0-260128", prompt: "A tree in rain", projectId: "project", ratio: "16:9", resolution: "1080p", duration: 10 };
const take = (batch: string, variation: number, size?: number) => ({ ...TAKE, batchId: batch, variation, ...(size ? { batchSize: size } : {}) });
let batchNo = 0;
const batchId = () => `b_npl${Math.random().toString(36).slice(2, 8)}${++batchNo}`;

test("a press of 4 x 57 cr (228 cr in all) from a member: every take is quoted and admitted, four jobs reserved; with no size named, the fourth take too", async () =>
  scope("npl-batch", async (service) => {
    const single = await quoteRoute(service).POST(quoteRequest(TAKE));
    expect(single.status, JSON.stringify(await single.clone().json())).toBe(200);
    expect((await single.json()).estimatedCredits).toBe(57);
    const id = batchId();
    const before = await counts();
    for (let variation = 1; variation <= 4; variation++) {
      const q = await quoteRoute(service).POST(quoteRequest(take(id, variation, 4)));
      expect(q.status, `take ${variation}: ${JSON.stringify(await q.clone().json())}`).toBe(200);
      const pressed = await press(service, take(id, variation, 4), `npl-batch4-${id}-${variation}`);
      expect(pressed.status, `take ${variation}: ${JSON.stringify(await pressed.clone().json())}`).toBeLessThan(300);
    }
    expect(await counts(), "four takes, four jobs").toEqual([before[0] + 4, before[1] + 4]);
    const loose = batchId();
    for (let variation = 1; variation <= 4; variation++)
      expect((await press(service, take(loose, variation), `npl-loose-${loose}-${variation}`)).status, `take ${variation}`).toBeLessThan(300);
  }, "npl-batch", member));

test("a press of 4 x 57 cr from a token: admitted, every take (no per-job line for machines either; a token's own monthly ceiling still applies at the reservation)", async () =>
  scope("npl-batch", async (service) => {
    const id = batchId();
    const before = (await meters()).length;
    for (let variation = 1; variation <= 4; variation++) {
      const made = await press(service, take(id, variation, 4), `npl-token-batch-${id}-${variation}`);
      expect(made.status, `take ${variation}: ${JSON.stringify(await made.clone().json())}`).toBeLessThan(300);
    }
    expect((await meters()).length - before).toBe(4);
  }, "npl-batch", { ...admin, token: { id: "tok_nplb", name: "agent", scope: "render", capUsd: null } } as AdmissionActor));
