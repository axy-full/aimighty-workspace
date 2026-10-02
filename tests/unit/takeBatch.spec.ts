import { test, expect } from "@playwright/test";
import {
  batchGate, batchNotice, batchPhase, batchSettledText, sendWorkspaceBatch,
  settleWorkspaceBatch, takesPhrase, takeView, rememberWorkspaceBatch, type BatchTake,
} from "../../lib/workspace/take-batch";
import { batchTotal, composerButtonLabel, composerButtonParts, type ComposerQuote } from "../../lib/workspace/composer";
import { pendingGenerationKey, readPendingGeneration } from "../../lib/workbench/pending-generation";
import { groupSiblings, stripLabel, takeLabel } from "../../lib/variations";
import type { GenerationBodyInput } from "../../lib/workbench/generation-request";

/**
 * Takes 2–4 of one Generate as ONE priced batch (lib/workspace/take-batch.ts),
 * against a stubbed server that counts every paid call. The money rules:
 * the sum of N fresh quotes is exactly what the button showed or nothing is
 * sent; a lost reply is checked (and fenced), never sent again; a take refused
 * part way stops the batch and says which takes were made and which were not.
 */

const SCOPE = "particl-active-ws_unit-u_unit";
const DRAFT = "draft-1";
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
    if (outcome.state === "sent") expect(batchNotice(outcome.takes)).toBe("4 takes sent at 72 cr. They file into Takes as one strip as they land.");
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
    expect(batchNotice(outcome.takes)).toBe("Takes 1–2 were sent at 36 cr. Takes 3–4 were not made (Not enough credits for this take). Nothing was charged for them.");
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
    expect(batchNotice(outcome.takes)).toBe("Takes 1–2 were sent at 36 cr. Takes 3–4 are held, not charged until they run: top up to release them at the same price.");
    /* A held take reads as held (waiting for the person), and the batch is over for the strip. */
    const held = takeView(outcome.takes[2], { media: { id: "gen_take3", status: "held", kind: "video", prompt: "", model: ENGINE, params: { held: { why: "credits" } } } });
    expect([held.status, held.tone, held.done]).toEqual(["Held · needs credits", "amber", true]);
    const slot = takeView(outcome.takes[3], { media: { id: "gen_take4", status: "held", kind: "video", prompt: "", model: ENGINE, params: { held: { why: "slots" } } } });
    expect([slot.status, slot.done]).toEqual(["Held · waiting for a slot", false]);
    const made = (i: number) => takeView(outcome.takes[i], { media: { id: `gen_take${i + 1}`, status: "succeeded", kind: "video", prompt: "", model: ENGINE } });
    const held4 = takeView(outcome.takes[3], { media: { id: "gen_take4", status: "held", kind: "video", prompt: "", model: ENGINE, params: { held: { why: "credits" } } } });
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
      expect(batchNotice(outcome.takes)).toBe("Take 1 was sent at 18 cr. Take 2: the reply never came back. It is checked before anything else is sent, and never sent twice. Take 3 was not made. Nothing was charged for it.");
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
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false, count: 4 })).toBe("Generate 4 takes · 72 cr");
  expect(composerButtonLabel({ quote: { ...quote, credits: 6.5 }, quoteKey: "k", submitting: false, count: 3 })).toBe("Generate 3 takes · 19.5 cr");
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false, count: 1 })).toBe("Generate · 18 cr");
  expect(composerButtonLabel({ quote, quoteKey: "stale", submitting: false, count: 2 })).toBe("Generate 2 takes");
  /* The same label in two parts, so a narrow button can put the whole price on its own line: never a cut figure. */
  expect(composerButtonParts({ quote: { ...quote, credits: 1234.5 }, quoteKey: "k", submitting: false, count: 4 })).toEqual({ action: "Generate 4 takes", price: "4,938 cr" });
  expect(composerButtonParts({ quote, quoteKey: "stale", submitting: false, count: 1 })).toEqual({ action: "Generate", price: null });
  expect(composerButtonParts({ quote, quoteKey: "k", submitting: true, count: 3 })).toEqual({ action: "Submitting…", price: null });
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
    takeView(take(1, "queued"), { media: { id: "gen_1", status: "succeeded", kind: "video", prompt: "", model: ENGINE } }),
    takeView(take(2, "queued"), { media: { id: "gen_2", status: "failed", kind: "video", prompt: "", model: ENGINE, creditsBilled: 0 } }),
    takeView(take(3, "refused", null), undefined),
    takeView(take(4, "not-sent", null), undefined),
  ];
  expect(views.map((v) => [v.label, v.status, v.tone, v.done])).toEqual([
    ["take 1", "Complete", "green", true], ["take 2", "Failed · not billed", "red", true],
    ["take 3", "Not made · not charged", "red", true], ["take 4", "Not sent · not charged", "idle", true],
  ]);
  expect(views[0].generationId).toBe("gen_1");
  expect(batchPhase(views)).toMatchObject({ label: "1 of 4 rendered", tone: "green", done: true });
  expect(batchSettledText("Harbour at dusk", views)).toBe("Harbour at dusk: 1 of 4 takes rendered, one strip in Takes. Takes 2–4 did not and cost nothing.");
  /* Sent, and not read yet: queued, still to come. */
  const rendering = takeView(take(1, "queued"), undefined);
  expect([rendering.status, rendering.done]).toEqual(["Queued", false]);
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

test("takes the connected account made keep their batch and take number in their kept originals, so Takes still draws the strip", () => {
  /* As the old collector filed them: nothing collects an account take any more, and the ones in the Library group as before. */
  const account = (id: string, variation: number) => ({ id, params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", batchId: "b_strip001", variation } });
  const strips = groupSiblings([account("gen_hfc_2", 2), account("gen_hfc_1", 1), { id: "gen_hfc_lone", params: { task: "connected-generation" } }]);
  expect(strips.map((s) => s.kind)).toEqual(["batch", "one"]);
  expect((strips[0] as { takes: { id: string }[] }).takes.map((t) => t.id)).toEqual(["gen_hfc_1", "gen_hfc_2"]);
});
