import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { GenerationRequestOptions } from "../../lib/generationRequests";
import { alignLedgerUnit } from "../helpers/ledgerUnit";
import { fundFixtureWorkspace } from "../helpers/fundFixtureWorkspace";
import { loadRouteModule } from "../helpers/vendorCostScan";

/**
 * A paid request that opts in to an early answer (answerAfterMs,
 * lib/generationRequests.ts): a run still going at the deadline is answered
 * with the claim's own "still being accepted" (409, pending, Retry-After), and
 * goes on after the reply, saving its reply on the claim exactly as it would
 * have. The money must not move because of it: one claim, one run, one
 * reservation and one settlement per Idempotency-Key, whatever is replayed and
 * whenever. Real local databases and the mocked engines (ENGINE_MOCK=1), the
 * mocked replies made slow by the test-only delay (lib/mock.ts mockDelayMs);
 * the deadline is shortened here, and its production value is asserted.
 * Nothing is billed for real.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-paid-answer-pending-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.CREDIT_USD = "0.10";
process.env.ENGINE_MOCK = "1";
process.env.PARTICL_TEST_MOCK_DELAYS = "1";

test.beforeAll(async () => { await alignLedgerUnit(); });

/** The shortened deadline, and a mocked reply that outlasts it. */
const DEADLINE_MS = 150;
const SLOW = "[[mock-delay:1500]]";

function workspace(name: string): TenantWorkspace {
  const id = `ws_pp_${name}_${randomUUID().slice(0, 8)}`;
  return { id, slug: id, name, legacy: false, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_pp", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}
const person = { id: "u_pp", email: "u_pp@example.test", name: "Pat", role: "admin", owner: true, disabled: false, lastSeen: null, createdAt: 0 } as TenantUser;

async function inTenant<T>(ws: TenantWorkspace, fn: () => Promise<T>): Promise<T> {
  const { runInTenant } = await import("../../lib/tenant");
  return runInTenant(ws, fn, { user: person });
}
/** A funded workspace on the platform's keys, its database ready. */
async function funded(name: string): Promise<TenantWorkspace> {
  const ws = workspace(name);
  const { ready } = await import("../../lib/db");
  await inTenant(ws, async () => { await ready(); await fundFixtureWorkspace(); });
  return ws;
}

/** Next's after(), as the server runs it: each callback once the reply has gone, when the test says so. */
function afterReplies() {
  const queued: (() => Promise<unknown>)[] = [];
  return {
    add: (work: () => Promise<unknown>) => { queued.push(work); },
    get count() { return queued.length; },
    /** The reply has been sent: run what was handed over, and wait for it. */
    flush: async () => { await Promise.all(queued.splice(0).map((work) => work())); },
  };
}

/** The meter's rows for this workspace (reservations and settlements), and its credit debits. */
async function books(workspaceId: string) {
  const { platformDb } = await import("../../lib/platform");
  const events = (await platformDb().execute({ sql: "SELECT id,status,billed_credits FROM meter_events WHERE workspace_id=? ORDER BY created_at,id", args: [workspaceId] })).rows
    .map((r) => ({ id: String(r.id), status: String(r.status), credits: Number(r.billed_credits) }));
  const debits = (await platformDb().execute({ sql: "SELECT event_id,credits FROM billing_debits WHERE workspace_id=? ORDER BY event_id", args: [workspaceId] })).rows
    .map((r) => ({ id: String(r.event_id), credits: Number(r.credits) }));
  return { events, debits };
}
async function claims(ws: TenantWorkspace) {
  const { db } = await import("../../lib/db");
  return inTenant(ws, async () => (await db().execute("SELECT request_key,response_status,response_json FROM generation_requests")).rows
    .map((r) => ({ key: String(r.request_key), status: r.response_status == null ? null : Number(r.response_status), saved: r.response_json != null })));
}
async function textJobs(ws: TenantWorkspace) {
  const { db } = await import("../../lib/db");
  return inTenant(ws, async () => (await db().execute("SELECT id,status FROM paid_text_jobs")).rows.map((r) => ({ id: String(r.id), status: String(r.status) })));
}
/** Recovery activities, read through the fence's own client: the database recoveryFence() writes now, whatever an earlier spec in this worker left platformDb() opened on. */
async function fenceRows(kind: string) {
  const { recoveryFence } = await import("../../lib/recovery");
  const fence = recoveryFence() as unknown as { client: { execute(s: { sql: string; args: string[] }): Promise<{ rows: Record<string, unknown>[] }> }; ready(): Promise<void> };
  await fence.ready();
  return (await fence.client.execute({ sql: "SELECT id,parent_id,state FROM recovery_activities WHERE kind=?", args: [kind] })).rows
    .map((r) => ({ id: String(r.id), parent: r.parent_id == null ? null : String(r.parent_id), state: String(r.state) }));
}
async function activities(kind: string) {
  return (await fenceRows(kind)).map((r) => r.state);
}

/** The model Atomik's Auto picks for writing, as the routes resolve it (inside the workspace). */
async function textModel(): Promise<string> {
  const { resolveModel } = await import("../../lib/atomik");
  return resolveModel("auto", "idea");
}

const post = (url: string, key: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...headers }, body: JSON.stringify(body) });

/** What a test watches of a request: anything read from it after `answered` is set is listed in `late`. */
function watched<T extends object>(target: T) {
  const log = { answered: false, late: [] as string[] };
  const proxy = new Proxy(target, {
    get(object, prop) {
      if (log.answered) log.late.push(String(prop));
      const value = Reflect.get(object, prop, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  return { value: proxy as T, log };
}

/** The early answer: the same "still being accepted" a replay of a running claim gets, never final. */
async function expectPending(response: Response) {
  expect(response.status).toBe(409);
  expect(response.headers.get("Idempotency-Status")).toBeNull();
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  const body = await response.json();
  expect(body.pending).toBe(true);
  expect(body.error).toMatch(/still being accepted/);
}

/* ── The wrapper ─────────────────────────────────────────────────────── */

test("the deadline a paid request is answered by is 25 s", async () => {
  const { ANSWER_AFTER_MS } = await import("../../lib/generationRequests");
  expect(ANSWER_AFTER_MS).toBe(25_000);
});

test("a run that finishes in time answers with its own reply, and nothing is handed to after()", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const ws = await funded("in-time");
  const later = afterReplies();
  let runs = 0;
  const response = await inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "in-time-key-1", { brief: "x" }), person.id,
    async () => { runs++; return Response.json({ logline: "done" }); }, { answerAfterMs: 5_000, afterReply: later.add }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Idempotency-Status")).toBe("complete");
  expect(await response.json()).toEqual({ logline: "done" });
  expect(later.count).toBe(0);
  expect(runs).toBe(1);
});

test("the early answer has the shape of a replay's pending answer; replays while it runs never run it again; a lost early reply's replay after it ends gets the saved reply", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const ws = await funded("shape");
  const later = afterReplies();
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async () => { runs++; await gate; return Response.json({ logline: "after the reply" }); };
  const send = () => inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "shape-key-01", { brief: "x" }), person.id, run, { answerAfterMs: DEADLINE_MS, afterReply: later.add }));

  const early = await send();
  await expectPending(early.clone());
  expect(later.count).toBe(1);
  /* A replay of a running claim is answered the same way (lib/generationRequests.ts): the client cannot tell them apart, and need not. */
  const replay = await send();
  await expectPending(replay.clone());
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(await early.json());
  /* Its continuation is reserved with the recovery fence while it runs, so a deploy that drains waits for it. */
  expect(await activities("paid-request")).toContain("active");

  release();
  await later.flush();
  /* The early reply was the only one sent, and say it was lost: the same request sent again is answered with the saved reply. */
  const after = await send();
  expect(after.status).toBe(200);
  expect(after.headers.get("Idempotency-Status")).toBe("complete");
  expect(after.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await after.json()).toEqual({ logline: "after the reply" });
  expect(runs).toBe(1);
  expect(await claims(ws)).toEqual([{ key: "shape-key-01", status: 200, saved: true }]);
  expect(await activities("paid-request")).not.toContain("active");
});

test("money, success: one claim and one reservation while pending, replays add nothing, and the run settles once with its charge", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { runPaidText } = await import("../../lib/paidText");
  const ws = await funded("charged");
  const later = afterReplies();
  let runs = 0;
  const run = async () => {
    runs++;
    const result = await runPaidText({ model: await textModel(), messages: [{ role: "user", content: `A note ${SLOW}` }], maxTokens: 600, kind: "idea", mock: "idea", createdBy: person.id });
    return Response.json({ id: result.id, credits: result.credits });
  };
  const send = () => inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "charged-key-1", { brief: "x" }), person.id, run, { answerAfterMs: DEADLINE_MS, afterReply: later.add }));

  await expectPending(await send());
  /* Reserved once, at the estimate, before the provider answered. */
  await expect.poll(async () => (await books(ws.id)).events.length).toBe(1);
  const held = await books(ws.id);
  expect(held.events[0].status).toBe("running");
  expect(held.events[0].credits).toBeGreaterThan(0);
  expect(held.debits).toEqual([{ id: held.events[0].id, credits: held.events[0].credits }]);
  for (let i = 0; i < 3; i++) await expectPending(await send());
  expect(await books(ws.id)).toEqual(held);
  expect(await textJobs(ws)).toEqual([{ id: held.events[0].id, status: "running" }]);

  await later.flush();
  const settled = await books(ws.id);
  expect(settled.events).toEqual([{ id: held.events[0].id, status: "succeeded", credits: settled.events[0].credits }]);
  expect(settled.events[0].credits).toBeGreaterThan(0);
  expect(settled.debits).toEqual([{ id: held.events[0].id, credits: settled.events[0].credits }]);
  const saved = await send();
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ id: held.events[0].id, credits: settled.events[0].credits });
  expect(await books(ws.id)).toEqual(settled);
  expect(await textJobs(ws)).toEqual([{ id: held.events[0].id, status: "succeeded" }]);
  expect(await claims(ws)).toEqual([{ key: "charged-key-1", status: 200, saved: true }]);
  expect(runs).toBe(1);
});

test("money, failure: a run that fails after the reply releases its reservation once, and its refusal is the saved, final reply", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { runPaidText, paidTextFailure } = await import("../../lib/paidText");
  const ws = await funded("released");
  const later = afterReplies();
  let runs = 0, submits = 0;
  const run = async () => {
    runs++;
    try {
      await runPaidText({ model: await textModel(), messages: [{ role: "user", content: "A note" }], maxTokens: 600, kind: "idea", mock: "idea", createdBy: person.id },
        { submit: async () => { submits++; await new Promise((resolve) => setTimeout(resolve, 1_000)); return { ok: false, status: 400, text: "{}" }; } });
      return Response.json({ ok: true });
    } catch (error) { return paidTextFailure(error); }
  };
  const send = () => inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "released-key1", { brief: "x" }), person.id, run, { answerAfterMs: DEADLINE_MS, afterReply: later.add }));

  await expectPending(await send());
  await expect.poll(async () => (await books(ws.id)).events.map((e) => e.status)).toEqual(["running"]);
  await expectPending(await send());
  await later.flush();
  const after = await books(ws.id);
  expect(after.events).toEqual([{ id: after.events[0].id, status: "failed", credits: 0 }]);
  expect(after.debits).toEqual([{ id: after.events[0].id, credits: 0 }]);
  const final = await send();
  expect(final.status).toBeGreaterThanOrEqual(400);
  expect(final.headers.get("Idempotency-Status")).toBe("complete");
  expect((await final.json()).error).toMatch(/No generation credits were charged/);
  expect(await books(ws.id)).toEqual(after);
  expect([runs, submits]).toEqual([1, 1]);
});

test("what the run admits after the reply hangs off its continuation, not off the request that is over", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { withRecoveryActivity } = await import("../../lib/recovery");
  const ws = await funded("handover");
  const later = afterReplies();
  const kinds = { request: `request-${randomUUID()}`, late: `late-${randomUUID()}` };
  const seen: { request?: { id: string }[]; continuation?: { id: string; parent: string | null }[]; late?: { parent: string | null }[] } = {};
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  /* As recoveryRoute admits every request (lib/auth.ts withTenant), and finishes it when the reply goes. */
  const response = await withRecoveryActivity(kinds.request, async () => {
    seen.request = await fenceRows(kinds.request);
    return inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "handover-key", { brief: "x" }), person.id, async () => {
      await gate;
      /* After the reply, as a provider call or a price check would be admitted. */
      await withRecoveryActivity(kinds.late, async () => {
        seen.continuation = (await fenceRows("paid-request")).map(({ id, parent }) => ({ id, parent }));
        seen.late = (await fenceRows(kinds.late)).map(({ parent }) => ({ parent }));
      });
      return Response.json({ ok: true });
    }, { answerAfterMs: DEADLINE_MS, afterReply: later.add }));
  });
  await expectPending(response);
  /* The request's own activity is over once it has answered. */
  expect(await fenceRows(kinds.request)).toEqual([]);
  release();
  await later.flush();
  const continuation = seen.continuation!.find((c) => c.parent === seen.request![0].id);
  expect(continuation, "the continuation was admitted under the open request").toBeTruthy();
  expect(seen.late).toEqual([{ parent: continuation!.id }]);
});

test("the request's cookies and headers are refused to a run once its request is answered, and read normally before", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { assertRequestAttached, RequestDetachedError } = await import("../../lib/requestAttachment");
  const { currentContext } = await import("../../lib/auth");
  const ws = await funded("detached");
  const later = afterReplies();
  const seen: { before?: string; after?: unknown } = {};
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const response = await inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "detached-key", { brief: "x" }), person.id, async () => {
    assertRequestAttached("The session cookie");
    seen.before = "attached";
    await gate;
    seen.after = await currentContext().then(() => "read", (error) => error);
    return Response.json({ ok: true });
  }, { answerAfterMs: DEADLINE_MS, afterReply: later.add }));
  await expectPending(response);
  release();
  await later.flush();
  expect(seen.before).toBe("attached");
  expect(seen.after).toBeInstanceOf(RequestDetachedError);
  /* Outside any early answer nothing changes: the guard is silent. */
  expect(() => assertRequestAttached("The session cookie")).not.toThrow();
});

test("with no request to defer to (after() unavailable), the request waits for its run and answers it", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const ws = await funded("no-after");
  let runs = 0;
  const response = await inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "no-after-key", { brief: "x" }), person.id, async () => {
    runs++;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return Response.json({ logline: "waited" });
  }, { answerAfterMs: DEADLINE_MS, afterReply: () => { throw new Error("`after` was called outside a request scope."); } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ logline: "waited" });
  expect(runs).toBe(1);
});

test("a run that never ends (the process stopped mid-run) keeps its claim pending and its reservation held: replays never run it again", async () => {
  const { withGenerationRequest } = await import("../../lib/generationRequests");
  const { runPaidText } = await import("../../lib/paidText");
  const ws = await funded("killed");
  const later = afterReplies();
  let runs = 0;
  /* The provider never answers: what a process stopped mid-run leaves, as far as the claim and the meter can tell. */
  const run = async () => {
    runs++;
    await runPaidText({ model: await textModel(), messages: [{ role: "user", content: "A note" }], maxTokens: 600, kind: "idea", mock: "idea", createdBy: person.id },
      { submit: () => new Promise(() => {}) });
    return Response.json({ ok: true });
  };
  const send = () => inTenant(ws, () => withGenerationRequest(post("http://localhost/api/atomik/ideas/draft", "killed-key-1", { brief: "x" }), person.id, run, { answerAfterMs: DEADLINE_MS, afterReply: later.add }));
  await expectPending(await send());
  for (let i = 0; i < 3; i++) await expectPending(await send());
  expect(runs).toBe(1);
  const held = await books(ws.id);
  expect(held.events.map((e) => e.status)).toEqual(["running"]);
  expect(held.events[0].credits).toBeGreaterThan(0);
  expect(await textJobs(ws)).toEqual([{ id: held.events[0].id, status: "running" }]);
  expect(await claims(ws)).toEqual([{ key: "killed-key-1", status: null, saved: false }]);
});

/* ── The routes that opt in ──────────────────────────────────────────── */

type Handler = (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** A route compiled against the real library, run as `person` in `ws`, its deadline shortened and its after() held by the test. */
async function route(file: string, ws: TenantWorkspace, overrides: Record<string, unknown> = {}) {
  const auth = await import("../../lib/auth");
  const requests = await import("../../lib/generationRequests");
  const { runInTenant } = await import("../../lib/tenant");
  const later = afterReplies();
  const opted: GenerationRequestOptions[] = [];
  const handler = loadRouteModule<{ POST: Handler }>(file, {
    "@/lib/auth": { ...auth,
      withTenant: (fn: Handler) => (req: Request, ctx?: { params: Promise<Record<string, string>> }) => runInTenant(ws, () => fn(req, ctx), { user: person, workspaces: [{ id: ws.id, slug: ws.slug, name: ws.name, role: "admin" }] }),
      requireUser: async () => ({ user: person }), requireRender: async () => ({ user: person }) },
    "@/lib/generationRequests": { ...requests, ANSWER_AFTER_MS: DEADLINE_MS,
      withGenerationRequest: (req: Request, userId: string, run: () => Promise<Response>, options: GenerationRequestOptions = {}) => {
        opted.push(options);
        return requests.withGenerationRequest(req, userId, run, { ...options, afterReply: later.add });
      } },
    ...overrides,
  });
  return { POST: handler.POST, later, opted };
}

/**
 * One paid press of a route that opts in, its run slower than the deadline:
 * answered pending, replayed while it runs, finished after the reply, and its
 * saved reply returned to a replay. Nothing is read from the request after the
 * early answer, and the meter sees one reservation and one settlement.
 */
async function pressedPastDeadline(ws: TenantWorkspace, loaded: Awaited<ReturnType<typeof route>>, url: string, body: Record<string, unknown>, ctx?: { params: Promise<Record<string, string>> }) {
  const key = `route-${randomUUID()}`;
  const press = () => {
    const req = watched(post(url, key, body));
    const context = ctx ? watched(ctx) : null;
    return { req, context, sent: loaded.POST(req.value, context?.value) };
  };
  const first = press();
  const early = await first.sent;
  first.req.log.answered = true;
  if (first.context) first.context.log.answered = true;
  await expectPending(early);
  expect(loaded.opted.map((o) => o.answerAfterMs)).toEqual([DEADLINE_MS]);
  const reserved = await books(ws.id);
  expect(reserved.events.map((e) => e.status)).toEqual(["running"]);
  await expectPending(await press().sent);
  await loaded.later.flush();
  /* Nothing in the run read the request (its body, headers or params) after the early answer. */
  expect(first.req.log.late).toEqual([]);
  expect(first.context?.log.late ?? []).toEqual([]);
  const saved = await press().sent;
  expect(saved.status).toBe(200);
  expect(saved.headers.get("Idempotency-Status")).toBe("complete");
  const settled = await books(ws.id);
  expect(settled.events).toHaveLength(1);
  expect(settled.events[0].id).toBe(reserved.events[0].id);
  expect(settled.events[0].status).toBe("succeeded");
  expect(settled.debits).toEqual([{ id: settled.events[0].id, credits: settled.events[0].credits }]);
  expect((await claims(ws)).filter((c) => c.key === key)).toEqual([{ key, status: 200, saved: true }]);
  return { reply: await saved.json(), settled };
}

test("POST /api/atomik/ideas/draft opts in: pending past the deadline, finished after the reply, charged once", async () => {
  const ws = await funded("ideas");
  const loaded = await route("app/api/atomik/ideas/draft/route.ts", ws);
  const { reply, settled } = await pressedPastDeadline(ws, loaded, "http://localhost/api/atomik/ideas/draft", { brief: `Car ad at dawn ${SLOW}` });
  expect(reply.logline).toMatch(/^Mocked logline/);
  expect(reply.writingCredits ?? reply.credits).toBe(settled.events[0].credits);
});

test("POST /api/atomik/shots/draft opts in: pending past the deadline, finished after the reply, charged once", async () => {
  const ws = await funded("shots");
  const atomikDocs = await import("../../lib/atomikDocs");
  const treatment = { logline: `A courier on the last night train ${SLOW}`, setup: {}, scenes: [{ n: 1, title: "Platform", secs: 12, prose: "Rain on the platform." }], updatedAt: 1 };
  const loaded = await route("app/api/atomik/shots/draft/route.ts", ws, { "@/lib/atomikDocs": { ...atomikDocs, getTreatment: async () => treatment } });
  const { reply, settled } = await pressedPastDeadline(ws, loaded, "http://localhost/api/atomik/shots/draft", { projectId: "p1", scene: 1 });
  expect(reply.shots.length).toBeGreaterThan(0);
  expect(reply.writingCredits).toBe(settled.events[0].credits);
});

test("POST /api/atomik/treatment/scene opts in: pending past the deadline, finished after the reply, charged once", async () => {
  const ws = await funded("scene");
  const atomikDocs = await import("../../lib/atomikDocs");
  const treatment = { logline: `A courier on the last night train ${SLOW}`, setup: {}, scenes: [{ n: 1, title: "Platform", secs: 12, prose: "Rain on the platform." }], updatedAt: 1 };
  const loaded = await route("app/api/atomik/treatment/scene/route.ts", ws, { "@/lib/atomikDocs": { ...atomikDocs, getTreatment: async () => treatment } });
  const { reply, settled } = await pressedPastDeadline(ws, loaded, "http://localhost/api/atomik/treatment/scene", { projectId: "p1", n: 1 });
  expect(reply.scene.title).toBe("Mocked scene");
  expect(reply.writingCredits).toBe(settled.events[0].credits);
});

test("POST /api/atomik/memory/read opts in: pending past the deadline, finished after the reply, charged once", async () => {
  const ws = await funded("memory");
  const loaded = await route("app/api/atomik/memory/read/route.ts", ws);
  const text = `Our audience is night riders. We never show faces. ${SLOW}`;
  const quoted = await (await loaded.POST(new Request("http://localhost/api/atomik/memory/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, quoteOnly: true }) }))).json();
  const ceiling = Number(quoted.estimateCredits ?? quoted.estimatedCredits);
  expect(ceiling).toBeGreaterThan(0);
  const { reply, settled } = await pressedPastDeadline(ws, loaded, "http://localhost/api/atomik/memory/read", { text, maxCredits: ceiling });
  expect(Array.isArray(reply.entries)).toBe(true);
  expect(reply.credits ?? reply.writingCredits).toBe(settled.events[0].credits);
});

test("POST /api/atomik/[id] (a planning turn) opts in: pending past the deadline, finished after the reply, charged once", async () => {
  const ws = await funded("turn");
  const atomik = await import("../../lib/atomik");
  const chatId = await inTenant(ws, () => atomik.createChat({ userId: person.id, projectId: null, model: "auto", agentMode: "ask" }));
  const loaded = await route("app/api/atomik/[id]/route.ts", ws, {
    "@/lib/atomik": { ...atomik, projectContext: async () => "" },
    "@/lib/rules": { effectiveRules: async () => [] },
    "@/lib/platformLayer": { writerRulesByScope: () => "" },
  });
  const ctx = () => ({ params: Promise.resolve({ id: chatId }) });
  const text = `Plan a short film about the market at dawn ${SLOW}`;
  const quoted = await (await loaded.POST(new Request(`http://localhost/api/atomik/${chatId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, quoteOnly: true }) }), ctx())).json();
  const ceiling = Number(quoted.estimateCredits ?? quoted.estimatedCredits);
  expect(ceiling).toBeGreaterThan(0);
  const { reply } = await pressedPastDeadline(ws, loaded, `http://localhost/api/atomik/${chatId}`, { text, maxCredits: ceiling }, ctx());
  expect(reply.chat.id).toBe(chatId);
  expect(reply.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
});

test("POST /api/audio/transcribe opts in: pending past the deadline, finished after the reply, its check answers with the transcript, charged once", async () => {
  const ws = await funded("transcribe");
  const transcription = await import("../../lib/transcription");
  const { db } = await import("../../lib/db");
  await inTenant(ws, () => db().execute({
    sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,kind,duration_s,created_at) VALUES(?,?,?,?,?,?,?,?,?,0)",
    args: ["up_slow", `line${SLOW}`, "audio/wav", "wav", 1000, "sha", "/api/uploads/up_slow", "audio", 60],
  }));
  /* The stored original's bytes are not on disk here; the provider is the mocked one, slowed by the delay in the source's name. */
  const loaded = await route("app/api/audio/transcribe/route.ts", ws, {
    "@/lib/transcription": { ...transcription, transcribe: (input: Parameters<typeof transcription.transcribe>[0], userId: string, options: Parameters<typeof transcription.transcribe>[2] = {}) =>
      transcription.transcribe(input, userId, { ...options, deps: { readSource: async () => Buffer.from("audio") } }) },
  });
  const quoted = await (await loaded.POST(new Request("http://localhost/api/audio/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceUploadId: "up_slow", quoteOnly: true }) }))).json();
  expect(quoted.estimatedCredits).toBeGreaterThan(0);
  const body = { sourceUploadId: "up_slow", diarize: true, maxCredits: quoted.estimatedCredits };
  const { reply, settled } = await pressedPastDeadline(ws, loaded, "http://localhost/api/audio/transcribe", body);
  expect(reply.text).toMatch(/Not tonight/);
  expect(reply.credits).toBe(settled.events[0].credits);
  /* The browser asks the check after a pending answer (lib/workbench/transcription-request.ts): it returns the same reply. */
  const { generationFingerprint } = await import("../../lib/generationRequests");
  const key = (await claims(ws))[0].key;
  expect(await inTenant(ws, () => transcription.checkTranscriptionRequest({ userId: person.id, key, fingerprint: generationFingerprint({ method: "POST", path: "/api/audio/transcribe", body }) })))
    .toEqual({ state: "answered", reply });
});
