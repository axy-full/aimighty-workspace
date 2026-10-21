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

const dir = mkdtempSync(path.join(tmpdir(), "particl-guardrail-4-admission-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const person = (id: string, role: "admin" | "member"): AdmissionActor => ({ user: { id, email: `${id}@example.invalid`, name: id, role, owner: role === "admin", disabled: false, createdAt: 0, lastSeen: null } });
const admin = person("owner", "admin"), member = person("u_member", "member");
/* A token's press carries its approved quote (owner, 20 Oct 2026; lib/tokenSpend.ts): a ceiling, maxCredits and a well-formed fingerprint, so it reaches the line. */
const ROOMY = { capUsd: 1_000_000, capCredits: 1_000_000 };
const FINGERPRINT = { quoteFingerprint: "f".repeat(64) };
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

/* Cinema Studio 4.0 at 720p, 30 s: about 209 cr (its hold is more); at 480p, 30 s: about 94 cr, whose hold (3 ×) is over the line. A Grok clip is far under it. */
const OVER = { model: "higgsfield-cinema-studio-4.0", prompt: "A tree in rain", projectId: "project", ratio: "16:9", resolution: "720p", duration: 30 };
const HELD_OVER = { ...OVER, resolution: "480p" };
const UNDER = { model: "grok-imagine-video", prompt: "A tree in rain", projectId: "project", ratio: "16:9", resolution: "720p", duration: 5 };

/* The press carries the ceiling its price was approved at (Cinema Studio's is approximate, so it must). */
const press = (service: ReturnType<typeof services>, body: Record<string, unknown>, key: string) => route("generation", service).POST(request("generation", { ...body, maxCredits: 5000 }, key));

test("through admission and the quote route: a member over the line is told 403 with needsAdmin before anything is created", async () =>
  scope("g4-line", async (service) => {
    const quote = quoteRoute(service);
    for (const [label, body] of [["its estimate", OVER], ["its hold", HELD_OVER]] as const) {
      /* The free quote, the prepared admission and the press all say the same, and nothing is written. */
      const before = [(await rows()).length, (await meters()).length];
      const q = await quote.POST(quoteRequest(body));
      expect(q.status, `${label}: ${JSON.stringify(await q.clone().json())}`).toBe(403);
      expect(await q.json(), label).toMatchObject({ needsAdmin: true, error: expect.stringMatching(/An admin has to start it\./) });
      expect(await service.gen.prepareGeneration(body, actor), label).toMatchObject({ ok: false, status: 403, body: { needsAdmin: true } });
      const pressed = await press(service, body, `g4-member-${label.replace(/\W+/g, "-")}`);
      expect(pressed.status, `${label}: ${JSON.stringify(await pressed.clone().json())}`).toBe(403);
      expect(await pressed.json(), label).toMatchObject({ needsAdmin: true });
      expect([(await rows()).length, (await meters()).length], `${label}: nothing created, nothing reserved`).toEqual(before);
    }
    /* Under the line nothing changes, for the member too. */
    const small = await quote.POST(quoteRequest(UNDER));
    expect(small.status).toBe(200);
  }, "g4-line", member));

test("through admission: an admin's own tap clears it (the quote answers, the press is admitted), and a token with an admin's identity is refused outright", async () => {
  await scope("g4-line", async (service) => {
    const ok = await quoteRoute(service).POST(quoteRequest(OVER));
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    expect((await ok.json()).estimatedCredits).toBeGreaterThan(200);
    const made = await press(service, OVER, "g4-admin");
    expect(made.status, JSON.stringify(await made.clone().json())).toBeLessThan(300);
  }, "g4-line", admin);
  await scope("g4-line", async (service) => {
    const viaToken = await quoteRoute(service).POST(quoteRequest(OVER));
    expect(viaToken.status).toBe(403);
    expect(await viaToken.json()).toMatchObject({ needsAdmin: true, error: expect.stringMatching(/never start it\./) });
    const viaPress = await press(service, { ...OVER, ...FINGERPRINT }, "g4-token");
    expect(viaPress.status).toBe(403);
    expect(await viaPress.json()).toMatchObject({ needsAdmin: true });
  }, "g4-line", { ...admin, token: { id: "tok_g4", name: "agent", scope: "render", ...ROOMY } } as AdmissionActor);
});

/* The house pays no credits and is judged at cost: this clip's hold (3 × its ~$14 estimate, counted in credits at no margin) is over the 200 cr line, so a member is told an admin must start it, in words with no figure. */
test("the house is judged at cost: a member over the line is told an admin must start it, with no credit figure; an admin clears it; a token is refused; under it nothing changes", async () => {
  await keepingHouseJobsClean(async () => {
    await scope("g4-house", async (service) => {
      const before = [(await rows()).length, (await meters()).length];
      const q = await quoteRoute(service).POST(quoteRequest(OVER));
      const answer = await q.clone().json();
      expect(q.status, JSON.stringify(answer)).toBe(403);
      expect(answer).toMatchObject({ needsAdmin: true, error: expect.stringMatching(/An admin has to start it\./) });
      expect(String(answer.error)).not.toMatch(/\bcr\b|\d/);
      const pressed = await press(service, OVER, "g4-house-member");
      expect(pressed.status).toBe(403);
      expect(await pressed.json()).toMatchObject({ needsAdmin: true });
      expect([(await rows()).length, (await meters()).length], "nothing created, nothing reserved").toEqual(before);
      expect((await quoteRoute(service).POST(quoteRequest(UNDER))).status).toBe(200);
    }, "ws_legacy", member);
    await scope("g4-house", async (service) => {
      const q = await quoteRoute(service).POST(quoteRequest(OVER));
      expect(q.status, JSON.stringify(await q.clone().json())).toBe(200);
      expect((await q.json()).unit).toBe("usd");
      const made = await press(service, OVER, "g4-house-admin");
      expect(made.status, JSON.stringify(await made.clone().json())).toBeLessThan(300);
    }, "ws_legacy", admin);
    await scope("g4-house", async (service) => {
      const viaToken = await quoteRoute(service).POST(quoteRequest(OVER));
      expect(viaToken.status).toBe(403);
      expect(await viaToken.json()).toMatchObject({ needsAdmin: true, error: expect.stringMatching(/never start it\./) });
      const viaPress = await press(service, { ...OVER, ...FINGERPRINT }, "g4-house-token");
      expect(viaPress.status).toBe(403);
      expect(await viaPress.json()).toMatchObject({ needsAdmin: true });
    }, "ws_legacy", { ...admin, token: { id: "tok_g4h", name: "agent", scope: "render", ...ROOMY } } as AdmissionActor);
  });
});

/* One press is one job: Seedance 2.0 at 1080p for 10 s is 57 cr a take, so a press of 4 is 228 cr as one job (over the line) and a press of 3 is 171 cr (under it). */
const TAKE = { model: "dreamina-seedance-2-0-260128", prompt: "A tree in rain", projectId: "project", ratio: "16:9", resolution: "1080p", duration: 10 };
const take = (batch: string, variation: number, size?: number) => ({ ...TAKE, batchId: batch, variation, ...(size ? { batchSize: size } : {}) });
let batchNo = 0;
const batchId = () => `b_g4${Math.random().toString(36).slice(2, 8)}${++batchNo}`;

test("one press is one job: 4 x 57 cr from a member is refused at the quote and at every take, and nothing is reserved for any take; a single take, and a press of 3, are unchanged", async () =>
  scope("g4-batch", async (service) => {
    const single = await quoteRoute(service).POST(quoteRequest(TAKE));
    expect(single.status, JSON.stringify(await single.clone().json())).toBe(200);
    expect((await single.json()).estimatedCredits).toBe(57);
    const id = batchId();
    const before = [(await rows()).length, (await meters()).length];
    for (let variation = 1; variation <= 4; variation++) {
      const q = await quoteRoute(service).POST(quoteRequest(take(id, variation, 4)));
      expect(q.status, `take ${variation}: ${JSON.stringify(await q.clone().json())}`).toBe(403);
      expect(await q.json()).toMatchObject({ needsAdmin: true, error: expect.stringMatching(/An admin has to start it\./) });
      const pressed = await press(service, take(id, variation, 4), `g4-batch4-${id}-${variation}`);
      expect(pressed.status, `take ${variation}`).toBe(403);
      expect(await pressed.json()).toMatchObject({ needsAdmin: true });
    }
    expect([(await rows()).length, (await meters()).length], "nothing created, nothing reserved for any take").toEqual(before);
    /* A single 57 cr take is unchanged. */
    expect((await press(service, TAKE, `g4-single-${id}`)).status).toBeLessThan(300);
    /* A press of 3 (171 cr as one job) goes, every take. */
    const three = batchId();
    for (let variation = 1; variation <= 3; variation++)
      expect((await press(service, take(three, variation, 3), `g4-batch3-${three}-${variation}`)).status, `take ${variation}`).toBeLessThan(300);
  }, "g4-batch", member));

test("one press is one job: the takes already reserved under its batch id count, so a batch that names no size is stopped at the take that passes the line", async () =>
  scope("g4-batch", async (service) => {
    const id = batchId();
    for (let variation = 1; variation <= 3; variation++)
      expect((await press(service, take(id, variation), `g4-acc-${id}-${variation}`)).status, `take ${variation}`).toBeLessThan(300);
    const before = [(await rows()).length, (await meters()).length];
    /* 57 x 4 = 228 cr: the fourth take of the same press is told an admin must start it. */
    const fourth = await press(service, take(id, 4), `g4-acc-${id}-4`);
    expect(fourth.status).toBe(403);
    expect(await fourth.json()).toMatchObject({ needsAdmin: true });
    expect([(await rows()).length, (await meters()).length]).toEqual(before);
  }, "g4-batch", member));

test("one press is one job: an admin's tap clears a press of 4 x 57 cr, every take; a token is refused at the first", async () => {
  await scope("g4-batch", async (service) => {
    const id = batchId();
    const before = (await meters()).length;
    for (let variation = 1; variation <= 4; variation++) {
      const q = await quoteRoute(service).POST(quoteRequest(take(id, variation, 4)));
      expect(q.status, `quote ${variation}: ${JSON.stringify(await q.clone().json())}`).toBe(200);
      const made = await press(service, take(id, variation, 4), `g4-admin-batch-${id}-${variation}`);
      expect(made.status, `take ${variation}: ${JSON.stringify(await made.clone().json())}`).toBeLessThan(300);
    }
    expect((await meters()).length - before).toBe(4);
  }, "g4-batch", admin);
  await scope("g4-batch", async (service) => {
    const id = batchId();
    const before = [(await rows()).length, (await meters()).length];
    const q = await quoteRoute(service).POST(quoteRequest(take(id, 1, 4)));
    expect(q.status).toBe(403);
    expect(await q.json()).toMatchObject({ needsAdmin: true, error: expect.stringMatching(/never start it\./) });
    const viaPress = await press(service, { ...take(id, 1, 4), ...FINGERPRINT }, `g4-token-batch-${id}`);
    expect(viaPress.status).toBe(403);
    expect(await viaPress.json()).toMatchObject({ needsAdmin: true });
    expect([(await rows()).length, (await meters()).length]).toEqual(before);
  }, "g4-batch", { ...admin, token: { id: "tok_g4b", name: "agent", scope: "render", ...ROOMY } } as AdmissionActor);
});
