import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  batchGate, batchNotice, batchPhase, batchSettledText, readPendingBatch, sendConnectedBatch, sendWorkspaceBatch,
  settleConnectedBatch, settleWorkspaceBatch, takesPhrase, takeView, rememberWorkspaceBatch, type BatchTake,
} from "../../lib/workspace/take-batch";
import { batchTotal, composerButtonLabel, composerButtonParts, shownTotal, type ComposerQuote } from "../../lib/workspace/composer";
import { pendingGenerationKey, readPendingGeneration } from "../../lib/workbench/pending-generation";
import { groupSiblings, stripLabel, takeLabel } from "../../lib/variations";
import { consumerVideoIdentity } from "../../lib/higgsfield-consumer/original-identity";
import type { ConsumerJob } from "../../lib/higgsfield-consumer/jobs";
import type { GenerationBodyInput } from "../../lib/workbench/generation-request";

/**
 * Takes 2–4 of one Generate as ONE priced batch (lib/workspace/take-batch.ts),
 * against a stubbed server that counts every paid call. The money rules:
 * the sum of N fresh quotes is exactly what the button showed or nothing is
 * sent; the connected account gets one paid call for the batch; a lost reply
 * is checked (and fenced), never sent again; a workspace take refused part way
 * stops the batch and says which takes were made and which were not.
 */

const SCOPE = "particl-active-ws_unit-u_unit";
const DRAFT = "draft-1";
const WALLET = "22222222-2222-4222-8222-222222222222";
const ENGINE = "dreamina-seedance-2-5-260628";

function memory() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k), items };
}
type Call = { path: string; key: string | null; body: Record<string, unknown> };
type Answer = { status?: number; json: unknown; complete?: boolean } | "network";
async function withServer(route: (path: string, body: Record<string, unknown>, calls: Call[]) => Answer, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, key: headers.get("Idempotency-Key"), body });
    const answer = route(path, body, calls);
    if (answer === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json", ...(answer.complete ? { "Idempotency-Status": "complete" } : {}) },
    });
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
}

/* ── The connected account ────────────────────────────────────────────── */

const input = { type: "image" as const, model: "nano_banana_2", prompt: "A plain bottle.", parameters: { resolution: "2k" }, medias: [] };
function job(id: string, variation: number, credits: number, overrides: Record<string, unknown> = {}) {
  return {
    id, draftId: DRAFT, status: "quoted", input, model: { id: "nano_banana_2", name: "Nano Banana 2", outputType: "image" },
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: credits, creditUnit: "higgsfield_credits",
    quoteExpiresAt: Date.now() + 300_000, providerJobId: null, createdAt: Date.now(), composer: "gen",
    batch: { id: "b_unit0001", variation }, ...overrides,
  };
}
/** A connected route for one test: quotes at `prices`, and counts every paid batch call. */
function connected(prices: number[], submit: (ids: string[], body: Record<string, unknown>) => Answer, check?: (ids: string[]) => Answer) {
  const paid: Record<string, unknown>[] = [];
  let quoted: ReturnType<typeof job>[] = [];
  const route = (path: string, body: Record<string, unknown>): Answer => {
    if (path !== "/api/higgsfield/consumer/generation") throw new Error(`Unexpected request: ${path}`);
    if (body.action === "quote-batch") {
      const keys = body.idempotencyKeys as string[];
      quoted = keys.map((_, i) => job(randomUUID(), i + 1, prices[i]));
      expect(body.batchId).toBe("b_unit0001");
      return { json: { jobs: quoted } };
    }
    if (body.action === "submit-batch") { paid.push(body); return submit(body.ids as string[], body); }
    if (body.action === "check-batch") return check ? check(body.ids as string[]) : { status: 500, json: {} };
    throw new Error(`Unexpected action ${String(body.action)}`);
  };
  return { route, paid, quoted: () => quoted };
}

test("connected: the sum of N fresh quotes is the one approval, sent in ONE paid batch call with every take's id", async () => {
  const storage = memory();
  const server = connected([18, 18, 18, 18], (ids) => ({ json: { jobs: ids.map((id, i) => job(id, i + 1, 18, { status: "accepted", providerJobId: randomUUID() })) } }));
  await withServer(server.route, async (calls) => {
    const outcome = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 4, shown: 72, batchId: "b_unit0001", composer: "gen", storage });
    expect(outcome.state).toBe("sent");
    /* One quote request for four takes, then exactly one paid call carrying all four ids and their exact sum. */
    expect(calls.map((call) => call.body.action)).toEqual(["quote-batch", "submit-batch"]);
    expect(server.paid).toEqual([{ action: "submit-batch", draftId: DRAFT, ids: server.quoted().map((j) => j.id), workspaceId: WALLET, credits: 72 }]);
    expect((calls[0].body.idempotencyKeys as string[]).length).toBe(4);
    if (outcome.state === "sent") expect(outcome.jobs.map((j) => [j.status, j.batch?.variation])).toEqual([["accepted", 1], ["accepted", 2], ["accepted", 3], ["accepted", 4]]);
    /* Answered: nothing is left waiting to be checked. */
    expect(readPendingBatch(storage, SCOPE, DRAFT)).toBeNull();
  });
});

test("connected: a price that moved sends NONE of the takes and puts the new sum on the button", async () => {
  const storage = memory();
  const server = connected([18, 18, 21, 18], () => { throw new Error("nothing may be sent"); });
  await withServer(server.route, async (calls) => {
    const outcome = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 4, shown: 72, batchId: "b_unit0001", storage });
    expect(outcome).toMatchObject({ state: "repriced", total: 75, takes: [18, 18, 21, 18] });
    expect(server.paid).toEqual([]);
    expect(calls.map((call) => call.body.action)).toEqual(["quote-batch"]);
    expect(readPendingBatch(storage, SCOPE, DRAFT)).toBeNull();
    /* The button now shows exactly that sum; the next press approves it. */
    const quote: ComposerQuote = { key: "k", credits: 18, state: "ready", reason: null, takes: [18, 18, 21, 18] };
    expect(composerButtonLabel({ billing: "connected", quote, quoteKey: "k", submitting: false, count: 4 })).toBe("Generate 4 takes · 75 connected cr");
    expect(shownTotal(quote, "k", 4)).toBe(75);
  });
  /* No figure at all is never an approval. */
  const again = connected([18, 18], () => { throw new Error("nothing may be sent"); });
  await withServer(again.route, async () => {
    expect((await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: null, batchId: "b_unit0001", storage })).state).toBe("repriced");
    expect(again.paid).toEqual([]);
  });
});

test("connected: quotes that do not match what was asked (another wallet, a missing take) are never sent", async () => {
  const storage = memory();
  const wrongWallet = (path: string, body: Record<string, unknown>): Answer => {
    if (body.action === "quote-batch") return { json: { jobs: [job(randomUUID(), 1, 9), job(randomUUID(), 2, 9, { workspaceId: "33333333-3333-4333-8333-333333333333" })] } };
    throw new Error(`nothing may be sent: ${path}`);
  };
  await withServer(wrongWallet, async (calls) => {
    expect((await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage })).state).toBe("refused");
    expect(calls).toHaveLength(1);
  });
  const short = (path: string, body: Record<string, unknown>): Answer => {
    if (body.action === "quote-batch") return { json: { jobs: [job(randomUUID(), 1, 9)] } };
    throw new Error(`nothing may be sent: ${path}`);
  };
  await withServer(short, async (calls) => {
    expect((await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage })).state).toBe("refused");
    expect(calls).toHaveLength(1);
  });
});

test("connected: a refusal the server answered (no free slots) sent nothing and says so; nothing is left to check", async () => {
  const storage = memory();
  const server = connected([9, 9], () => ({ status: 429, json: { code: "capacity", error: "All four connected-account slots are in use." } }));
  await withServer(server.route, async (calls) => {
    const outcome = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage });
    expect(outcome.state).toBe("refused");
    if (outcome.state === "refused") expect(outcome.reason).toMatch(/^Nothing was sent or charged: the connected account already has jobs running; a batch of 2 needs 2 free slots\.$/);
    expect(server.paid).toHaveLength(1);
    expect(calls.map((call) => call.body.action)).toEqual(["quote-batch", "submit-batch"]);
    expect(readPendingBatch(storage, SCOPE, DRAFT)).toBeNull();
  });
});

test("connected: a lost reply is checked, never sent again — landed is followed, never-arrived is fenced, unknown blocks the next send", async () => {
  /* Landed: the batch had reached the account; its takes come back to follow, and there is no second paid call. */
  let storage = memory();
  let server = connected([9, 9], () => "network", (ids) => ({ json: { state: "landed", jobs: ids.map((id, i) => job(id, i + 1, 9, { status: "accepted", providerJobId: randomUUID() })) } }));
  await withServer(server.route, async (calls) => {
    const outcome = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage });
    expect(outcome).toMatchObject({ state: "sent" });
    if (outcome.state === "sent") expect(outcome.jobs.map((j) => j.status)).toEqual(["accepted", "accepted"]);
    expect(calls.map((call) => call.body.action)).toEqual(["quote-batch", "submit-batch", "check-batch"]);
    expect(calls[2].body.ids).toEqual(server.quoted().map((j) => j.id));
    expect(server.paid).toHaveLength(1);
    expect(readPendingBatch(storage, SCOPE, DRAFT)).toBeNull();
  });
  /* Never arrived: the check fenced it on the server, so it never can arrive; nothing was charged. */
  storage = memory();
  server = connected([9, 9], () => ({ status: 503, json: { error: "The connected account could not complete this request." } }), () => ({ json: { state: "absent", jobs: [] } }));
  await withServer(server.route, async (calls) => {
    const outcome = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage });
    expect(outcome).toEqual({ state: "refused", reason: "The batch never reached the connected account. Nothing was charged; press Generate to send it again." });
    expect(calls.map((call) => call.body.action)).toEqual(["quote-batch", "submit-batch", "check-batch"]);
    expect(server.paid).toHaveLength(1);
    expect(readPendingBatch(storage, SCOPE, DRAFT)).toBeNull();
  });
  /* A take already claimed by another submit is not a refusal: it is checked like a lost reply. */
  storage = memory();
  server = connected([9, 9], () => ({ status: 409, json: { code: "already_submitted", error: "A step in this batch already has a submission." } }),
    (ids) => ({ json: { state: "landed", jobs: ids.map((id, i) => job(id, i + 1, 9, { status: "dispatching" })) } }));
  await withServer(server.route, async (calls) => {
    expect((await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage })).state).toBe("sent");
    expect(calls.map((call) => call.body.action)).toEqual(["quote-batch", "submit-batch", "check-batch"]);
  });
  /* An answer that does not name every take is no answer: checked like a lost reply, never taken as sent. */
  storage = memory();
  server = connected([9, 9], (ids) => ({ json: { jobs: [job(ids[0], 1, 9, { status: "accepted", providerJobId: randomUUID() })] } }),
    (ids) => ({ json: { state: "landed", jobs: ids.map((id, i) => job(id, i + 1, 9, { status: "accepted", providerJobId: randomUUID() })) } }));
  await withServer(server.route, async (calls) => {
    const outcome = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage });
    expect(outcome.state).toBe("sent");
    if (outcome.state === "sent") expect(outcome.jobs).toHaveLength(2);
    expect(calls.map((call) => call.body.action)).toEqual(["quote-batch", "submit-batch", "check-batch"]);
    expect(server.paid).toHaveLength(1);
    expect(readPendingBatch(storage, SCOPE, DRAFT)).toBeNull();
  });
  /* Not known (the check itself got no answer): the batch stays remembered and the next Generate asks first, sending nothing. */
  storage = memory();
  let checks = 0;
  server = connected([9, 9], () => "network", () => { checks++; return "network"; });
  await withServer(server.route, async (calls) => {
    const outcome = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage });
    expect(outcome.state).toBe("unknown");
    const pending = readPendingBatch(storage, SCOPE, DRAFT);
    expect(pending).toMatchObject({ draftId: DRAFT, batchId: "b_unit0001", ids: server.quoted().map((j) => j.id), workspaceId: WALLET, credits: 18 });
    expect((await settleConnectedBatch({ scope: SCOPE, draftId: DRAFT, storage })).state).toBe("unknown");
    expect(readPendingBatch(storage, SCOPE, DRAFT)).not.toBeNull();
    /* While it is not known, another batch on the project is refused before anything is sent. */
    const blocked = await sendConnectedBatch({ scope: SCOPE, draftId: DRAFT, input, count: 2, shown: 18, batchId: "b_unit0001", storage });
    expect(blocked).toMatchObject({ state: "refused", reason: "Another batch on this project is still waiting for its answer. Nothing new was sent." });
    expect(server.paid).toHaveLength(1);
    expect(checks).toBe(2);
    expect(calls.filter((call) => call.body.action === "submit-batch")).toHaveLength(1);
  });
  /* Once the check is answered, the record is let go and the answer is final. */
  await withServer((_, body) => {
    if (body.action === "check-batch") return { json: { state: "absent", jobs: [] } };
    throw new Error("nothing may be sent");
  }, async (calls) => {
    expect((await settleConnectedBatch({ scope: SCOPE, draftId: DRAFT, storage })).state).toBe("lost");
    expect(readPendingBatch(storage, SCOPE, DRAFT)).toBeNull();
    expect((await settleConnectedBatch({ scope: SCOPE, draftId: DRAFT, storage })).state).toBe("none");
    expect(calls).toHaveLength(1);
  });
});

/* ── This workspace's credits ─────────────────────────────────────────── */

const body = (variation: number): GenerationBodyInput => ({
  prompt: "Close on her hands.", kind: "video", model: { id: ENGINE }, mapping: { shotId: "shot_1", productionProjectId: "prod_1" },
  ratio: "16:9", resolution: "720p", duration: 5, references: [], firstFrameAssetId: "", batch: { id: "b_unit0002", variation },
});
const storageId = (variation: number) => pendingGenerationKey(SCOPE, DRAFT, `shot-1:take-${variation}`);
/** The workspace routes for one test: a quote per exact body at `price(variation)`, and admission's answer per take. */
function workspace(price: (variation: number) => number, admit: (variation: number, attempt: number) => Answer) {
  const charged: { variation: number; maxCredits: unknown; key: string | null }[] = [];
  const attempts = new Map<number, number>();
  const route = (path: string, sent: Record<string, unknown>, calls: Call[]): Answer => {
    const variation = Number(sent.variation);
    if (path === "/api/generate/quote") {
      expect(sent.batchId).toBe("b_unit0002");
      expect(sent.maxCredits).toBeUndefined();
      return { json: { estimatedCredits: price(variation), fingerprint: String(variation).repeat(64).slice(0, 64) } };
    }
    if (path === "/api/generate") {
      const n = (attempts.get(variation) ?? 0) + 1;
      attempts.set(variation, n);
      const answer = admit(variation, n);
      if (answer !== "network" && (answer.status ?? 200) < 300) charged.push({ variation, maxCredits: sent.maxCredits, key: calls[calls.length - 1].key });
      return answer;
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return { route, charged };
}

test("workspace: every take is quoted exactly as it will be sent, then each goes with the same batch id, its own take number and its own ceiling", async () => {
  const storage = memory();
  const server = workspace(() => 18, (variation) => ({ json: { id: `gen_take${variation}` }, complete: true }));
  await withServer(server.route, async (calls) => {
    const outcome = await sendWorkspaceBatch({ scope: SCOPE, shown: 72, count: 4, storageId, storage, request: (v) => ({ endpoint: "/api/generate", input: body(v) }) });
    expect(outcome.state).toBe("sent");
    /* All four prices first, then the four takes: nothing is sent before the whole batch is priced. */
    expect(calls.map((call) => call.path)).toEqual([...Array(4).fill("/api/generate/quote"), ...Array(4).fill("/api/generate")]);
    const sent = calls.filter((call) => call.path === "/api/generate");
    expect(sent.map((call) => [call.body.batchId, call.body.variation, call.body.maxCredits])).toEqual([1, 2, 3, 4].map((v) => ["b_unit0002", v, 18]));
    expect(new Set(sent.map((call) => call.key)).size).toBe(4);
    if (outcome.state === "sent") expect(outcome.takes.map((t) => [t.state, t.jobId])).toEqual([1, 2, 3, 4].map((v) => ["queued", `gen_take${v}`]));
    expect(server.charged).toHaveLength(4);
    for (const v of [1, 2, 3, 4]) expect(readPendingGeneration(storage, storageId(v))).toBeNull();
    if (outcome.state === "sent") expect(batchNotice(outcome.takes, "cr")).toBe("4 takes sent at 72 cr. They file into Takes as one strip as they land.");
  });
});

test("workspace: a price that moved sends NONE of the takes", async () => {
  const storage = memory();
  const server = workspace((v) => (v === 3 ? 20 : 18), () => { throw new Error("nothing may be sent"); });
  await withServer(server.route, async (calls) => {
    const outcome = await sendWorkspaceBatch({ scope: SCOPE, shown: 72, count: 4, storageId, storage, request: (v) => ({ endpoint: "/api/generate", input: body(v) }) });
    expect(outcome).toMatchObject({ state: "repriced", total: 74, takes: [18, 18, 20, 18] });
    expect(calls.every((call) => call.path === "/api/generate/quote")).toBe(true);
    expect(server.charged).toEqual([]);
    for (const v of [1, 2, 3, 4]) expect(readPendingGeneration(storage, storageId(v))).toBeNull();
    if (outcome.state === "repriced") expect(outcome.reason).toBe("The price is now 74 cr for 4 takes. Nothing was sent; press Generate again to approve it.");
  });
  /* A quote that cannot be had is not a price: nothing is sent either. */
  await withServer((path) => (path === "/api/generate/quote" ? { status: 503, json: { error: "The live price could not be read." } } : "network"), async (calls) => {
    const outcome = await sendWorkspaceBatch({ scope: SCOPE, shown: 36, count: 2, storageId, storage, request: (v) => ({ endpoint: "/api/generate", input: body(v) }) });
    expect(outcome.state).toBe("refused");
    expect(calls.every((call) => call.path === "/api/generate/quote")).toBe(true);
  });
});

test("workspace: admission refusing take 3 (credits ran out) stops the batch there; the notice says exactly what was made and charged", async () => {
  const storage = memory();
  const server = workspace(() => 18, (variation) => variation < 3
    ? { json: { id: `gen_take${variation}` }, complete: true }
    : { status: 402, json: { error: "Not enough credits for this take." }, complete: true });
  await withServer(server.route, async (calls) => {
    const outcome = await sendWorkspaceBatch({ scope: SCOPE, shown: 72, count: 4, storageId, storage, request: (v) => ({ endpoint: "/api/generate", input: body(v) }) });
    if (outcome.state !== "sent") throw new Error(outcome.state);
    expect(outcome.takes.map((t) => t.state)).toEqual(["queued", "queued", "refused", "not-sent"]);
    /* Take 4 was never asked for; only takes 1 and 2 were admitted (charged). */
    expect(calls.filter((call) => call.path === "/api/generate").map((call) => call.body.variation)).toEqual([1, 2, 3]);
    expect(server.charged.map((c) => c.variation)).toEqual([1, 2]);
    expect(batchNotice(outcome.takes, "cr")).toBe("Takes 1–2 were sent at 36 cr. Takes 3–4 were not made (Not enough credits for this take). Nothing was charged for them.");
    /* A durable refusal is let go: nothing waits to be recovered for it. */
    expect(readPendingGeneration(storage, storageId(3))).toBeNull();
  });
});

test("workspace: when the credits run out admission holds takes 3–4: said so, not charged until they run, and never counted as sent", async () => {
  const storage = memory();
  const server = workspace(() => 18, (variation) => variation < 3
    ? { json: { id: `gen_take${variation}`, status: "running" }, complete: true }
    : { status: 202, json: { id: `gen_take${variation}`, status: "held", held: true, needs: 18 }, complete: true });
  await withServer(server.route, async (calls) => {
    const outcome = await sendWorkspaceBatch({ scope: SCOPE, shown: 72, count: 4, storageId, storage, request: (v) => ({ endpoint: "/api/generate", input: body(v) }) });
    if (outcome.state !== "sent") throw new Error(outcome.state);
    expect(outcome.takes.map((t) => [t.state, t.jobId])).toEqual([["queued", "gen_take1"], ["queued", "gen_take2"], ["held", "gen_take3"], ["held", "gen_take4"]]);
    expect(calls.filter((call) => call.path === "/api/generate")).toHaveLength(4);
    expect(batchNotice(outcome.takes, "cr")).toBe("Takes 1–2 were sent at 36 cr. Takes 3–4 are held, not charged until they run: top up to release them at the same price.");
    /* A held take reads as held (waiting for the person), and the batch is over for the strip. */
    const held = takeView(outcome.takes[2], "workspace", { media: { id: "gen_take3", status: "held", kind: "video", prompt: "", model: ENGINE, params: { held: { why: "credits" } } } });
    expect([held.status, held.tone, held.done]).toEqual(["Held · needs credits", "amber", true]);
    const slot = takeView(outcome.takes[3], "workspace", { media: { id: "gen_take4", status: "held", kind: "video", prompt: "", model: ENGINE, params: { held: { why: "slots" } } } });
    expect([slot.status, slot.done]).toEqual(["Held · waiting for a slot", false]);
    const made = (i: number) => takeView(outcome.takes[i], "workspace", { media: { id: `gen_take${i + 1}`, status: "succeeded", kind: "video", prompt: "", model: ENGINE } });
    const held4 = takeView(outcome.takes[3], "workspace", { media: { id: "gen_take4", status: "held", kind: "video", prompt: "", model: ENGINE, params: { held: { why: "credits" } } } });
    expect(batchSettledText("Harbour", [made(0), made(1), held, held4])).toBe("Harbour: 2 of 4 takes rendered, one strip in Takes. Takes 3–4 are held, not charged until they run.");
    expect(batchPhase([made(0), made(1), held, held4])).toMatchObject({ label: "2 of 4 rendered", done: true });
  });
});

for (const found of ["landed", "absent"] as const)
  test(`workspace: a lost reply on take 2 stops the batch; the next Generate checks it by its own key (${found}) and never sends it again`, async () => {
    const storage = memory();
    let checks: Record<string, unknown>[] = [];
    const server = workspace(() => 18, (variation, attempt) => variation === 2 && attempt === 1 ? "network" : { json: { id: `gen_take${variation}` }, complete: true });
    const route = (path: string, sent: Record<string, unknown>, calls: Call[]): Answer => {
      /* The server's record of the lost request decides (POST /api/generate/check): it landed, or it never arrived and is fenced now. */
      if (path === "/api/generate/check") { checks.push(sent); return { json: found === "landed" ? { state: "landed", id: "gen_take2", status: "running" } : { state: "absent" } }; }
      return server.route(path, sent, calls);
    };
    await withServer(route, async (calls) => {
      const outcome = await sendWorkspaceBatch({ scope: SCOPE, shown: 54, count: 3, storageId, storage, request: (v) => ({ endpoint: "/api/generate", input: body(v) }) });
      if (outcome.state !== "sent") throw new Error(outcome.state);
      expect(outcome.takes.map((t) => t.state)).toEqual(["queued", "unconfirmed", "not-sent"]);
      expect(batchNotice(outcome.takes, "cr")).toBe("Take 1 was sent at 18 cr. Take 2: the reply never came back. It is checked before anything else is sent, and never sent twice. Take 3 was not made. Nothing was charged for it.");
      /* Its claim is kept for the check. */
      const claimed = readPendingGeneration(storage, storageId(2));
      expect(claimed).not.toBeNull();
      rememberWorkspaceBatch(storage, SCOPE, { projectId: DRAFT, batchId: "b_unit0002", name: "Close on her hands.", model: "Seedance 2.5", takes: [{ variation: 2, storageId: storageId(2), credits: 18 }] });
      checks = [];
      const settled = await settleWorkspaceBatch({ scope: SCOPE, projectId: DRAFT, storage });
      expect(settled).toMatchObject(found === "landed"
        ? { state: "settled", landed: [{ variation: 2, jobId: "gen_take2", credits: 18 }], lost: [] }
        : { state: "settled", landed: [], lost: [2] });
      /* Asked about by its own key, route and body — the request exactly as it was sent — and never sent again. */
      expect(checks).toEqual([{ key: claimed!.key, endpoint: "/api/generate", body: claimed!.body }]);
      expect(calls.filter((call) => call.path === "/api/generate").map((call) => call.body.variation)).toEqual([1, 2]);
      expect(calls.filter((call) => call.path === "/api/generate/quote")).toHaveLength(3);
      expect(readPendingGeneration(storage, storageId(2))).toBeNull();
      expect(await settleWorkspaceBatch({ scope: SCOPE, projectId: DRAFT, storage })).toEqual({ state: "none" });
    });
  });

test("workspace: a lost take whose check gets no answer stays unconfirmed, and nothing new is sent until it is answered", async () => {
  const storage = memory();
  const server = workspace(() => 18, (variation) => variation === 2 ? "network" : { json: { id: `gen_take${variation}` }, complete: true });
  const route = (path: string, sent: Record<string, unknown>, calls: Call[]): Answer => (path === "/api/generate/check" ? "network" : server.route(path, sent, calls));
  await withServer(route, async (calls) => {
    const outcome = await sendWorkspaceBatch({ scope: SCOPE, shown: 36, count: 2, storageId, storage, request: (v) => ({ endpoint: "/api/generate", input: body(v) }) });
    if (outcome.state !== "sent") throw new Error(outcome.state);
    rememberWorkspaceBatch(storage, SCOPE, { projectId: DRAFT, batchId: "b_unit0002", name: "Close on her hands.", model: "Seedance 2.5", takes: [{ variation: 2, storageId: storageId(2), credits: 18 }] });
    const settled = await settleWorkspaceBatch({ scope: SCOPE, projectId: DRAFT, storage });
    expect(settled.state).toBe("unknown");
    if (settled.state === "unknown") expect(settled.reason).toMatch(/could not be checked yet .* so nothing new was sent\. Try again in a moment\.$/);
    expect(readPendingGeneration(storage, storageId(2))).not.toBeNull();
    expect(calls.filter((call) => call.path === "/api/generate")).toHaveLength(2);
  });
});

/* ── What the person sees ─────────────────────────────────────────────── */

test("the button's total is the take's price summed per take, and a batch of one keeps the single label", () => {
  const quote: ComposerQuote = { key: "k", credits: 18, state: "ready", reason: null };
  expect(composerButtonLabel({ billing: "workspace", quote, quoteKey: "k", submitting: false, count: 4 })).toBe("Generate 4 takes · 72 cr");
  expect(composerButtonLabel({ billing: "connected", quote: { ...quote, credits: 6.5 }, quoteKey: "k", submitting: false, count: 3 })).toBe("Generate 3 takes · 19.5 connected cr");
  expect(composerButtonLabel({ billing: "workspace", quote, quoteKey: "k", submitting: false, count: 1 })).toBe("Generate · 18 cr");
  expect(composerButtonLabel({ billing: "workspace", quote, quoteKey: "stale", submitting: false, count: 2 })).toBe("Generate 2 takes");
  /* The same label in two parts, so a narrow button can put the whole price on its own line: never a cut figure. */
  expect(composerButtonParts({ billing: "connected", quote: { ...quote, credits: 1234.5 }, quoteKey: "k", submitting: false, count: 4 })).toEqual({ action: "Generate 4 takes", price: "4,938 connected cr" });
  expect(composerButtonParts({ billing: "workspace", quote, quoteKey: "stale", submitting: false, count: 1 })).toEqual({ action: "Generate", price: null });
  expect(composerButtonParts({ billing: "workspace", quote, quoteKey: "k", submitting: true, count: 3 })).toEqual({ action: "Submitting…", price: null });
  /* A batch's own figures only count for exactly that many takes. */
  expect(batchTotal(18, 3, [18, 19])).toBe(54);
  expect(batchTotal(18, 2, [18, 19])).toBe(37);
  /* Summed the way the fresh total is summed, so an unchanged fractional price compares equal. */
  expect(batchGate(batchTotal(0.1, 3), [0.1, 0.1, 0.1]).ok).toBe(true);
  expect(batchGate(null, [9, 9]).ok).toBe(false);
});

test("each take says what became of it, the strip says how far the batch is, and the toast says what it cost", () => {
  const take = (variation: number, state: BatchTake["state"], jobId: string | null = `gen_${variation}`): BatchTake => ({ variation, state, jobId, credits: 18 });
  const views = [
    takeView(take(1, "queued"), "workspace", { media: { id: "gen_1", status: "succeeded", kind: "video", prompt: "", model: ENGINE } }),
    takeView(take(2, "queued"), "workspace", { media: { id: "gen_2", status: "failed", kind: "video", prompt: "", model: ENGINE, creditsBilled: 0 } }),
    takeView(take(3, "refused", null), "workspace", undefined),
    takeView(take(4, "not-sent", null), "workspace", undefined),
  ];
  expect(views.map((v) => [v.label, v.status, v.tone, v.done])).toEqual([
    ["take 1", "Complete", "green", true], ["take 2", "Failed · not billed", "red", true],
    ["take 3", "Not made · not charged", "red", true], ["take 4", "Not sent · not charged", "idle", true],
  ]);
  expect(views[0].generationId).toBe("gen_1");
  expect(batchPhase(views)).toMatchObject({ label: "1 of 4 rendered", tone: "green", done: true });
  expect(batchSettledText("Harbour at dusk", views)).toBe("Harbour at dusk: 1 of 4 takes rendered, one strip in Takes. Takes 2–4 did not and cost nothing.");
  const rendering = takeView(take(1, "queued"), "connected", undefined);
  expect([rendering.status, rendering.done]).toEqual(["Checking with the account", false]);
  expect(batchPhase([rendering, views[0]])).toMatchObject({ label: "1 of 2 rendered", tone: "blue", done: false });
  expect(takesPhrase([1, 3])).toBe("takes 1 and 3");
  expect(takesPhrase([4])).toBe("take 4");
});

test("a batch's takes gather into one strip in take order whatever order the library lists them, labelled take 1–4", () => {
  const listed = [4, 2, 3, 1].map((variation) => ({ id: `gen_${variation}`, params: { batchId: "b_strip001", variation } }));
  const strips = groupSiblings([{ id: "gen_single", params: {} }, ...listed]);
  expect(strips.map((s) => s.kind)).toEqual(["one", "batch"]);
  const batch = strips[1] as { takes: { id: string; params: { variation: number } }[] };
  expect(batch.takes.map((t) => t.id)).toEqual(["gen_1", "gen_2", "gen_3", "gen_4"]);
  expect(stripLabel(batch.takes.map((t) => t.params.variation))).toBe("take 1–4");
  expect(stripLabel([2, 3])).toBe("take 2–3");
  expect(takeLabel(3)).toBe("take 3");
});

test("a connected take's kept original carries its batch and take number, so Takes can draw the strip", () => {
  const payload = {
    input: { ...input, medias: [] }, params: { model: "nano_banana_2" }, workspaceName: "Fixture wallet",
    model: { id: "nano_banana_2", name: "Nano Banana 2", outputType: "image" }, batch: { id: "b_strip001", variation: 2 },
  };
  const jobRow = { workflow: "generation", payloadJson: JSON.stringify(payload), draftId: DRAFT } as unknown as ConsumerJob;
  expect(consumerVideoIdentity(jobRow).params).toMatchObject({ task: "connected-generation", batchId: "b_strip001", variation: 2 });
  const lone = { ...jobRow, payloadJson: JSON.stringify({ ...payload, batch: undefined }) } as ConsumerJob;
  expect(consumerVideoIdentity(lone).params).not.toHaveProperty("batchId");
  const forged = { ...jobRow, payloadJson: JSON.stringify({ ...payload, batch: { id: "../x", variation: 99 } }) } as ConsumerJob;
  expect(consumerVideoIdentity(forged).params).not.toHaveProperty("batchId");
});
