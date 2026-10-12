import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type {
  AdmissionActor,
} from "../../lib/admissionTypes";

const dir = mkdtempSync(path.join(tmpdir(), "particl-guardrail-4-admission-"));
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
  await platformDb().execute({
    sql: "INSERT OR IGNORE INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [id, name, name, `file:${path.join(dir, name + ".db")}`],
  });
  if (id !== "ws_legacy") await grantCredits(id, 10000, "Test", "owner", "manual");
  for (const [account, role] of [["owner", "owner"], ["u_member", "member"]] as const)
    await platformDb().execute({ sql: "INSERT OR IGNORE INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,0,0)", args: [id, account, role] });
  const ws = rowToWorkspace(
    (
      await platformDb().execute({
        sql: "SELECT * FROM workspaces WHERE id=?",
        args: [id],
      })
    ).rows[0],
  );
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
    expect((await press(service, OVER, "g4-token")).status).toBe(403);
  }, "g4-line", { ...admin, token: { id: "tok_g4", name: "agent", scope: "render", capUsd: null } } as AdmissionActor);
});

test("a member on their own key (the house workspace, which pays no credits) is not refused and is shown no credit price", async () =>
  scope("g4-house", async (service) => {
    const q = await quoteRoute(service).POST(quoteRequest(OVER));
    expect(q.status, JSON.stringify(await q.clone().json())).toBe(200);
    expect((await q.json()).unit).toBe("usd");
    const made = await press(service, OVER, "g4-house-press");
    expect(made.status, JSON.stringify(await made.clone().json())).toBeLessThan(300);
  }, "ws_legacy", member));
