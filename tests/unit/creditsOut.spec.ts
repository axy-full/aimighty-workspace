import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * Idea 4 — a way out when credits run out. Release charges the exact price on
 * its button once, at admission, and only for whom the route allows; a
 * second press or a lost reply never releases or charges twice; still short
 * is a 402 that charges nothing. Packs are asked for by the owner or an admin
 * only, withdrawn requests are kept, every read and write stays in its
 * workspace, and with no mail key nothing is sent anywhere.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-credits-out-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
/* Never a mail key, in any test: the point is that nothing is sent without one. */
delete process.env.RESEND_API_KEY;
delete process.env.MAIL_FROM;
delete process.env.PAYMENT_PROVIDER;

function workspace(name: string, concurrency = 4): TenantWorkspace {
  return {
    id: `ws_${name}`, slug: name, name, legacy: false,
    dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "u_owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  };
}
/* Unit files share one platform database per worker: every name here is this file's own. */
async function setup(name: string, credits: number, concurrency = 4) {
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  const ws = workspace(`credits-out-${name}`, concurrency);
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,created_at) VALUES(?,?,?,'test',?)",
    args: [`grant_${ws.id}`, ws.id, credits, Date.now()],
  });
  return ws;
}
/* A held take with fixed test pricing. `heldAt` is the figure it was held at;
   a different one says the price moved while it waited. */
async function held(id: string, by: string, heldAt = 15, at = Date.now()) {
  const { db, ready } = await import("../../lib/db");
  await ready();
  await db().execute({
    sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
          VALUES(?,'video','byteplus','dreamina-seedance-2-0-260128','test',?,'held',?,?,?,'byteplus','generate')`,
    args: [id, JSON.stringify({ ratio: "16:9", resolution: "720p", duration: 5, watermark: false, held: { estUsd: 1, needs: heldAt, at: 1, why: "credits" } }), by, at, at],
  });
}
/* What the ledger took for a take: the sum of its debits, however many times it was reserved. */
const debited = async (id: string) => {
  const { platformDb } = await import("../../lib/platform");
  return Number((await platformDb().execute({ sql: "SELECT COALESCE(SUM(credits),0) AS n FROM billing_debits WHERE event_id=?", args: [id] })).rows[0].n);
};
const row = async (id: string) => {
  const { db } = await import("../../lib/db");
  return (await db().execute({ sql: "SELECT status,error,json_extract(params,'$.releasedAt') AS released FROM generations WHERE id=?", args: [id] })).rows[0];
};
const metered = async (id: string) => {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE id=?", args: [id] })).rows;
};
const balance = async () => (await (await import("../../lib/credits")).creditState())?.balance ?? null;

/** A route module with its auth (and, for the top-up route, its mail) swapped for the test's; everything else real. */
function loadRoute<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}
type Person = { id: string; name: string; role: "admin" | "member"; owner?: boolean };
const OWNER: Person = { id: "u_owner", name: "Owner", role: "admin", owner: true };
const ADMIN: Person = { id: "u_admin", name: "Admin", role: "admin" };
const MEMBER: Person = { id: "u_member", name: "Member", role: "member" };
const OTHER: Person = { id: "u_other", name: "Teammate", role: "member" };

/** Nothing leaves the process: every outgoing request is counted and refused. */
function watchNetwork() {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("A unit test may not reach the network.");
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** The engine is stood in for: a release's paid submission is counted, never sent. */
async function standInEngine() {
  const { engineFor } = await import("../../lib/engines");
  const engine = engineFor("byteplus"), original = engine.render;
  const submits: string[] = [];
  engine.render = (async () => { submits.push("submit"); return { handle: { provider: "byteplus", ref: `mock-${submits.length}`, model: "mock" } }; }) as typeof engine.render;
  return { submits, restore: () => { engine.render = original; } };
}

function releaseRoute(user: () => Person) {
  const route = loadRoute<typeof import("../../app/api/jobs/[id]/release/route")>("app/api/jobs/[id]/release/route.ts", {
    "@/lib/auth": { requireUser: async () => ({ user: user(), token: null }), withTenant: (handler: unknown) => handler },
  });
  return (id: string, body?: unknown) => (route.POST as unknown as (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>)(
    new Request(`http://unit.invalid/api/jobs/${id}/release`, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve({ id }) },
  );
}

test("Release: the author, the owner or an admin — never another member — and only at the price on the button", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  let user = OTHER;
  const release = releaseRoute(() => user);
  const engine = await standInEngine();
  const net = watchNetwork();
  try {
    await runInTenant(await setup("who", 100), async () => {
      await held("gen_co_who_member", MEMBER.id);
      await held("gen_co_who_admin", MEMBER.id);
      await held("gen_co_who_owner", MEMBER.id);

      /* Another member: refused, nothing reserved, the take still held. */
      const refused = await release("gen_co_who_member", { credits: 15 });
      expect(refused.status).toBe(403);
      expect((await refused.json()).error).toContain("Only the person who made this take, or an admin");
      expect(await row("gen_co_who_member")).toMatchObject({ status: "held" });
      expect(await metered("gen_co_who_member")).toEqual([]);

      /* No price, or a price that is not the take's: nothing starts. */
      user = MEMBER;
      expect((await release("gen_co_who_member")).status).toBe(400);
      const moved = await release("gen_co_who_member", { credits: 14 });
      expect(moved.status).toBe(409);
      expect(await moved.json()).toEqual({ error: "The price is now 15 cr. Press Release again to approve it.", credits: 15 });
      expect(await metered("gen_co_who_member")).toEqual([]);
      expect(await balance()).toBe(100);

      /* Its author, at the price shown: charged once at admission, and sent once. */
      const own = await release("gen_co_who_member", { credits: 15 });
      expect(own.status).toBe(200);
      expect(await own.json()).toEqual({ released: true, id: "gen_co_who_member" });
      /* Sent at once (the engine is stood in for): on the engine, stamped released. */
      expect(await row("gen_co_who_member")).toMatchObject({ status: "running", released: expect.any(Number) });
      expect(await metered("gen_co_who_member")).toEqual([expect.objectContaining({ status: "running", billed_credits: 15 })]);
      expect(await balance()).toBe(85);

      /* An admin or the owner releases anyone's. */
      user = ADMIN;
      expect((await release("gen_co_who_admin", { credits: 15 })).status).toBe(200);
      user = OWNER;
      expect((await release("gen_co_who_owner", { credits: 15 })).status).toBe(200);
      expect(await balance()).toBe(55);
    });
    /* Another workspace cannot reach this one's take at all. */
    await runInTenant(await setup("elsewhere", 100), async () => {
      user = OWNER;
      expect((await release("gen_co_who_member", { credits: 15 })).status).toBe(404);
    });
    expect(engine.submits).toHaveLength(3);
    expect(net.calls).toEqual([]);
  } finally {
    net.restore();
    engine.restore();
  }
});

test("Release: a double press and a lost reply release once and charge once; still short is a 402 that charges nothing", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const release = releaseRoute(() => MEMBER);
  const engine = await standInEngine();
  const net = watchNetwork();
  try {
    await runInTenant(await setup("once", 20), async () => {
      await held("gen_co_once", MEMBER.id);
      await held("gen_co_short", MEMBER.id);

      /* Two presses at the same moment: both hear "released", one reservation, one submission. */
      const [a, b] = await Promise.all([release("gen_co_once", { credits: 15 }), release("gen_co_once", { credits: 15 })]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const replies = [await a.json(), await b.json()];
      expect(replies.every((r) => r.released === true)).toBe(true);
      expect(replies.filter((r) => r.already === true)).toHaveLength(1);
      expect(await metered("gen_co_once")).toEqual([expect.objectContaining({ billed_credits: 15 })]);
      expect(await debited("gen_co_once")).toBe(15);
      expect(await balance()).toBe(5);

      /* The reply was lost and the person presses again: it is already released; nothing more is charged. */
      const again = await release("gen_co_once", { credits: 15 });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ released: true, id: "gen_co_once", already: true });
      expect(await debited("gen_co_once")).toBe(15);
      expect(await balance()).toBe(5);
      expect(engine.submits).toHaveLength(1);

      /* Still short: the route's own words, and nothing reserved or charged. */
      const short = await release("gen_co_short", { credits: 15 });
      expect(short.status).toBe(402);
      expect(await short.json()).toEqual({ error: "Still short: this needs 15 credits and 5 are left.", credits: 15 });
      expect(await row("gen_co_short")).toMatchObject({ status: "held", released: null });
      expect(await metered("gen_co_short")).toEqual([]);
      expect(await balance()).toBe(5);
    });
    expect(net.calls).toEqual([]);
  } finally {
    net.restore();
    engine.restore();
  }
});

test("Release: every slot busy says so and charges nothing; a discarded take is not released", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { discardHeldJob } = await import("../../lib/held");
  const { db } = await import("../../lib/db");
  const release = releaseRoute(() => MEMBER);
  const engine = await standInEngine();
  const net = watchNetwork();
  try {
    await runInTenant(await setup("slots", 100, 1), async () => {
      await held("gen_co_slot_busy", MEMBER.id);
      await held("gen_co_gone", MEMBER.id);
      await db().execute({
        sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
              VALUES('gen_co_running','video','byteplus','dreamina-seedance-2-0-260128','test','{}','running',?,?,?,'byteplus','generate')`,
        args: [MEMBER.id, Date.now(), Date.now()],
      });
      const busy = await release("gen_co_slot_busy", { credits: 15 });
      expect(busy.status).toBe(409);
      expect((await busy.json()).error).toBe("Every render slot is busy. It starts on its own when one is free.");
      expect(await metered("gen_co_slot_busy")).toEqual([]);
      expect(await discardHeldJob("gen_co_gone")).toBe(true);
      const gone = await release("gen_co_gone", { credits: 15 });
      expect(gone.status).toBe(409);
      expect((await gone.json()).error).toBe("This take is not held.");
      expect(await balance()).toBe(100);
    });
    expect(engine.submits).toEqual([]);
    expect(net.calls).toEqual([]);
  } finally {
    net.restore();
    engine.restore();
  }
});

test("Release: short with every slot busy is said as short, never as 'starts on its own'", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const release = releaseRoute(() => MEMBER);
  const engine = await standInEngine();
  try {
    await runInTenant(await setup("short-busy", 5, 1), async () => {
      await held("gen_co_short_busy", MEMBER.id);
      await db().execute({
        sql: `INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_by,created_at,updated_at,billed_to,task)
              VALUES('gen_co_busy','video','byteplus','dreamina-seedance-2-0-260128','test','{}','running',?,?,?,'byteplus','generate')`,
        args: [MEMBER.id, Date.now(), Date.now()],
      });
      const short = await release("gen_co_short_busy", { credits: 15 });
      expect(short.status).toBe(402);
      expect((await short.json()).error).toBe("Still short: this needs 15 credits and 5 are left.");
      expect(await debited("gen_co_short_busy")).toBe(0);
    });
    expect(engine.submits).toEqual([]);
  } finally {
    engine.restore();
  }
});

test("a price that moved while a take waited is started only by a person approving it; the browser is shown that price", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { releaseHeldJobs } = await import("../../lib/held");
  const { getGeneration } = await import("../../lib/jobs");
  const release = releaseRoute(() => MEMBER);
  const engine = await standInEngine();
  try {
    await runInTenant(await setup("moved", 100), async () => {
      const t = Date.now() - 60_000;
      /* Held at 12 (what Generate showed), now 15; the take behind it is at its own price. */
      await held("gen_co_moved", MEMBER.id, 12, t);
      await held("gen_co_behind", MEMBER.id, 15, t + 1);
      /* A top-up, a settlement or the cron: nobody approved 15, so it waits and says why; the take behind starts. */
      const out = await releaseHeldJobs({ defer: async () => {} });
      expect(out.released).toEqual(["gen_co_behind"]);
      expect(await row("gen_co_moved")).toMatchObject({ status: "held", error: "The price is now 15 cr. Release it at that price to start it." });
      expect(await debited("gen_co_moved")).toBe(0);
      /* The card shows what Release would charge now, not the old figure. */
      expect((await getGeneration("gen_co_moved"))?.params.held).toEqual({ why: "credits", needs: 15 });
      /* A person pressing Release at 15 is the approval. */
      expect((await release("gen_co_moved", { credits: 12 })).status).toBe(409);
      expect((await release("gen_co_moved", { credits: 15 })).status).toBe(200);
      expect(await debited("gen_co_moved")).toBe(15);
      expect(await balance()).toBe(70);
    });
  } finally {
    engine.restore();
  }
});

function topupsRoute(user: () => Person, sent: unknown[]) {
  const mail = createRequire(path.resolve("app/api/workspaces/topups/route.ts"))("@/lib/mail") as typeof import("../../lib/mail");
  const platform = createRequire(path.resolve("app/api/workspaces/topups/route.ts"))("@/lib/platform") as typeof import("../../lib/platform");
  const route = loadRoute<typeof import("../../app/api/workspaces/topups/route")>("app/api/workspaces/topups/route.ts", {
    "@/lib/auth": { requireUser: async () => ({ user: user(), token: null }), withTenant: (handler: unknown) => handler },
    /* The real mail module, with its send watched; the platform admin's address set as CI sets it. */
    "@/lib/mail": { ...mail, sendMail: async (msg: unknown) => { sent.push(msg); return mail.sendMail(msg as Parameters<typeof mail.sendMail>[0]); } },
    "@/lib/platform": { ...platform, SUPER_ADMIN_EMAIL: "platform-owner@example.test" },
  });
  const call = (method: "GET" | "POST" | "DELETE", query = "", body?: unknown) =>
    (route[method] as unknown as (req: Request) => Promise<Response>)(new Request(`http://unit.invalid/api/workspaces/topups${query}`, {
      method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  return call;
}
const request = async (id: string) => {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT workspace_id,status,credits,bonus_credits,usd FROM topup_requests WHERE id=?", args: [id] })).rows[0];
};

test("Packs: the owner or an admin asks and withdraws, a member cannot; a withdrawn request is kept; nothing crosses workspaces", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { platformDb } = await import("../../lib/platform");
  let user = MEMBER;
  const sent: unknown[] = [];
  const call = topupsRoute(() => user, sent);
  const net = watchNetwork();
  try {
    const home = await setup("packs", 0), away = await setup("packs-away", 0);
    let theirs = "";
    await runInTenant(away, async () => {
      user = OWNER;
      theirs = (await (await call("POST", "", { packId: "starter" })).json()).request.id;
    });
    await runInTenant(home, async () => {
      /* A member reads the packs, is told who asks, and is refused both writes. */
      user = MEMBER;
      const seen = await (await call("GET")).json();
      expect(seen).toMatchObject({ applies: true, canRequest: false, provider: "manual" });
      expect(seen.packs.map((p: { id: string; total: number; usd: number }) => [p.id, p.total, p.usd])).toEqual([["starter", 500, 50], ["team", 2200, 200], ["studio", 5750, 500], ["agency", 24000, 2000]]);
      const before = Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM topup_requests WHERE workspace_id=?", args: [home.id] })).rows[0].n);
      const asked = await call("POST", "", { packId: "team" });
      expect(asked.status).toBe(403);
      expect((await asked.json()).error).toBe("The owner or an admin asks for credits.");
      expect(Number((await platformDb().execute({ sql: "SELECT COUNT(*) AS n FROM topup_requests WHERE workspace_id=?", args: [home.id] })).rows[0].n)).toBe(before);

      /* An admin asks: the pack's own figures are frozen on the request, nothing is charged, and no mail goes without a key. */
      user = ADMIN;
      expect((await (await call("GET")).json()).canRequest).toBe(true);
      const made = await call("POST", "", { packId: "team" });
      expect(made.status).toBe(201);
      const body = await made.json();
      expect(body).toMatchObject({ checkout: { kind: "queued" }, emailed: false, request: { label: "Team", credits: 2000, bonus: 200, usd: 200, status: "requested" } });
      expect(await request(body.request.id)).toMatchObject({ workspace_id: home.id, status: "requested", credits: 2000, bonus_credits: 200, usd: 200 });
      expect(await balance()).toBe(0);
      expect((await call("POST", "", { packId: "made-up" })).status).toBe(400);

      /* A member cannot withdraw it; another workspace's request is not this one's to withdraw. */
      user = MEMBER;
      expect((await call("DELETE", `?id=${body.request.id}`)).status).toBe(403);
      expect(await request(body.request.id)).toMatchObject({ status: "requested" });
      user = OWNER;
      expect((await call("DELETE", `?id=${theirs}`)).status).toBe(404);
      expect(await request(theirs)).toMatchObject({ workspace_id: away.id, status: "requested" });

      /* The owner withdraws: marked, never erased, and it stays in the list as withdrawn. */
      expect((await call("DELETE", `?id=${body.request.id}`)).status).toBe(200);
      expect(await request(body.request.id)).toMatchObject({ status: "cancelled", credits: 2000 });
      expect((await call("DELETE", `?id=${body.request.id}`)).status).toBe(404);
      const listed = (await (await call("GET")).json()).requests as { id: string; status: string }[];
      expect(listed.find((r) => r.id === body.request.id)).toMatchObject({ status: "cancelled" });
      expect(listed.some((r) => r.id === theirs)).toBe(false);
    });
    /* Nothing was sent anywhere: no mail key, so the send was never tried, and no request left the process. */
    expect(sent).toEqual([]);
    expect(net.calls).toEqual([]);
  } finally {
    net.restore();
  }
});

test("lib/mail without a key: not configured, and a send is refused before any request is made", async () => {
  const { mailConfigured, sendMail } = await import("../../lib/mail");
  const net = watchNetwork();
  try {
    expect(process.env.RESEND_API_KEY).toBeUndefined();
    expect(mailConfigured()).toBe(false);
    await expect(sendMail({ to: "platform-owner@example.test", subject: "s", text: "t", html: "<p>t</p>" })).rejects.toThrow("Email isn't set up");
    expect(net.calls).toEqual([]);
  } finally {
    net.restore();
  }
});

test("a take held for credits is its own state: Held · needs N cr, its price, and Release only where the route allows", async () => {
  const { projectTakes, takeChip, takeReasonLine, takeStatusWord } = await import("../../lib/workspace/takes");
  const { mayRelease, heldNeeds } = await import("../../lib/workspace/release");
  const { generationPhase } = await import("../../lib/workspace/rig");
  const gen = (id: string, fields: Record<string, unknown>) => ({ origin: "generation" as const, value: {
    id, projectId: "p", projectName: null, arkTaskId: null, kind: "video", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
    approvedBy: null, approvedAt: null, model: "dreamina-seedance-2-0-260128", prompt: "", title: id, params: {}, status: "succeeded", sourceUrl: null,
    storedUrl: null, totalTokens: null, costUsd: null, creditsBilled: null, providerCreditQuote: null, refineCostUsd: null, refineModel: null,
    refineInTokens: null, refineOutTokens: null, error: null, createdBy: "u", authorName: null, shotId: null, shotCode: null, shotScene: null,
    shotTitle: null, version: 1, durationMs: null, durationS: null, provider: "byteplus", attempts: 1, task: "generate", sourceGenId: null,
    createdAt: 1, updatedAt: 1, ...fields,
  } });
  const [credits, slots, capped] = projectTakes([
    gen("h", { status: "held", params: { held: { why: "credits", needs: 11.2 } } }),
    gen("s", { status: "held", params: { held: { why: "slots" } } }),
    gen("c", { status: "held", error: "This take and reserved takes exceed the shot's credit cap. An admin must start it.", params: { held: { why: "credits", needs: 40 } } }),
  ] as never);
  /* Held for credits is not "rendering": its own status, the need on the chip, nothing charged. */
  expect(credits).toMatchObject({ status: "held", needs: 12, credits: null, reason: "Needs 12 cr" });
  expect(takeChip(credits)).toEqual({ label: "Held · needs 12 cr", tone: "waiting" });
  expect(takeStatusWord(credits)).toBe("Held · needs 12 cr");
  /* The chip carries the need; the 2-up tile says Held and the need under the name. */
  expect(takeReasonLine(credits)).toBeNull();
  expect(takeChip(credits, true)).toEqual({ label: "Held", tone: "waiting" });
  expect(takeReasonLine(credits, true)).toBe("Needs 12 cr");
  /* Waiting for a slot is a place in the line. */
  expect(slots).toMatchObject({ status: "rendering", stage: "queued", reason: "Waiting for a free slot" });
  expect(slots.needs).toBeUndefined();
  /* A release its own cap refused says so, under the need. */
  expect(capped).toMatchObject({ status: "held", needs: 40, reason: "This take and reserved takes exceed the shot's credit cap." });
  expect(takeReasonLine(capped)).toBe("This take and reserved takes exceed the shot's credit cap.");
  expect(heldNeeds({ held: { why: "slots", needs: 5 } })).toBeNull();
  expect(heldNeeds(null)).toBeNull();
  expect(generationPhase({ status: "held", params: { held: { why: "credits", needs: 12 } } } as never).label).toBe("Held · needs 12 cr");
  expect(generationPhase({ status: "held" } as never).label).toBe("Held · needs credits");
  /* The same rule the route reads. */
  expect(mayRelease({ id: "u_member", role: "member" }, "u_member")).toBe(true);
  expect(mayRelease({ id: "u_member", role: "member" }, "u_other")).toBe(false);
  expect(mayRelease({ id: null, role: "member" }, null)).toBe(false);
  expect(mayRelease({ id: "u_admin", role: "admin" }, "u_other")).toBe(true);
  expect(mayRelease({ id: "u_owner", role: "owner" }, "u_other")).toBe(true);
});

test("the amber pill reads the last quote in this workspace's credits and never asks for one", async () => {
  const { lastWorkspaceQuote, lowBalance, rememberWorkspaceQuote } = await import("../../lib/workspace/last-quote");
  expect(lastWorkspaceQuote("scope-a")).toBeNull();
  expect(lowBalance(10, null)).toBe(false);
  rememberWorkspaceQuote("scope-a", 12.2);
  expect(lastWorkspaceQuote("scope-a")).toMatchObject({ credits: 13 });
  expect(lowBalance(12, lastWorkspaceQuote("scope-a"))).toBe(true);
  expect(lowBalance(13, lastWorkspaceQuote("scope-a"))).toBe(false);
  /* Unknown is not low; another workspace's quote is not this one's. */
  expect(lowBalance(null, lastWorkspaceQuote("scope-a"))).toBe(false);
  expect(lastWorkspaceQuote("scope-b")).toBeNull();
  for (const bad of [Number.NaN, -1, null, undefined]) rememberWorkspaceQuote("scope-a", bad as number);
  expect(lastWorkspaceQuote("scope-a")).toMatchObject({ credits: 13 });
  expect(lowBalance(0, { credits: 0 })).toBe(false);
});

test("Plans lists packs as the platform prices them, requests by where they stand, and grants as they came in", async () => {
  const { packLine, packRequestLabel, requestLine, requestRows, grantRow } = await import("../../lib/shell/workspace-view");
  const team = { id: "team", label: "Team", credits: 2000, bonus: 200, total: 2200, usd: 200 };
  expect(packLine(team)).toBe("2,200 cr · $200 · 200 free");
  expect(packRequestLabel(team)).toBe("Request 2,200 credits");
  const at = Date.UTC(2026, 8, 27, 12);
  const rows = requestRows([
    { id: "a", label: "Team", credits: 2000, bonus: 200, usd: 200, status: "cancelled", createdAt: at, decidedAt: at },
    { id: "b", label: "Starter", credits: 500, bonus: 0, usd: 50, status: "requested", createdAt: at, decidedAt: null },
    { id: "c", label: "Studio", credits: 5000, bonus: 750, usd: 500, status: "approved", createdAt: at, decidedAt: at },
  ]);
  expect(rows.map((r) => r.id)).toEqual(["b", "a", "c"]);
  expect(rows.map(requestLine)).toEqual([
    "Starter · 500 cr · waiting on the platform since Sep 27",
    "Team · 2,200 cr · withdrawn Sep 27",
    "Studio · 5,750 cr · added Sep 27",
  ]);
  expect(grantRow({ id: "g", credits: 2000, note: "Team pack · 2,000 credits", createdAt: at })).toEqual({ amount: "+2,000 cr", what: "Team pack · 2,000 credits", when: "Sep 27" });
  expect(grantRow({ id: "g", credits: -50, note: " ", createdAt: at })).toMatchObject({ amount: "−50 cr", what: "Credits removed" });
});
