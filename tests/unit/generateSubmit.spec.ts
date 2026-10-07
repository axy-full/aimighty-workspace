import { test, expect } from "@playwright/test";
import { checkQuote, dispatchGeneration, sendClaimedGeneration, settlePendingGeneration, settleStoredRequest, type QuoteCheck } from "../../lib/workspace/generate-submit";
import { claimPendingGeneration, pendingGenerationKey, readOwnClaim, readPendingGeneration, SETTLED_MS } from "../../lib/workbench/pending-generation";
import type { GenerationBodyInput } from "../../lib/workbench/generation-request";
import { viralRequest } from "../../lib/shell/viral";
import { imageAdRequest, INITIAL_IMAGE_AD } from "../../lib/shell/image-ads";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";
import { MARKETING_IMAGE_MODEL_ID } from "../../lib/models";

/**
 * The shared workspace-credit dispatch (the Rig, the Gen composer, Storyboards,
 * Environment, Edit) with an attempt claimed earlier whose reply was lost. The
 * server's record of its Idempotency-Key decides, and the stored request is
 * never sent again: landed, its job is followed and nothing is quoted or sent;
 * never arrived (or refused), it is let go and what is on screen now is quoted,
 * held to the price on the button and sent under a new key; not known yet,
 * nothing is sent and the claim stays. A stubbed server; nothing is billed.
 */

const ENGINE = "dreamina-seedance-2-5-260628";
const SCOPE = "particl-active-ws_unit-u_unit";
const STORAGE_ID = pendingGenerationKey(SCOPE, "draft-1", "shot-a");
const STALE = { key: "stale-request-0001", body: JSON.stringify({ prompt: "Wide. Hold still.", model: ENGINE, duration: 5, maxCredits: 18 }), credits: 18, endpoint: "/api/generate" as const };

function memory() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}
const edited = (): GenerationBodyInput => ({
  prompt: "Close on her hands.", kind: "video", model: { id: ENGINE }, mapping: { shotId: "shot_1", productionProjectId: "prod_1" },
  ratio: "16:9", resolution: "720p", duration: 6, references: [], firstFrameAssetId: "",
});

type Call = { path: string; key: string | null; body: Record<string, unknown> };
type Answer = { status?: number; json: unknown; headers?: Record<string, string> } | "network";
/** A stub server for one test: each route answers from `routes`, and every call is recorded. */
async function withServer(routes: Record<string, (body: Record<string, unknown>) => Answer>, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, key: headers.get("Idempotency-Key"), body });
    const answer = routes[path]?.(body);
    if (!answer) throw new Error(`Unexpected request: ${path}`);
    if (answer === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "Content-Type": "application/json", ...answer.headers } });
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
}
const quote = () => ({ json: { estimatedCredits: 21, fingerprint: "f".repeat(64) } });

test("a lost attempt that landed is followed: nothing is quoted or sent, and its own job and approved price come back", async () => {
  const storage = memory();
  claimPendingGeneration(storage, STORAGE_ID, STALE);
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_landed", status: "running" } }) }, async (calls) => {
    const outcome = await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() } });
    expect(outcome).toEqual({ state: "queued", jobId: "gen_landed", credits: 18 });
    /* Asked by its own key, route and body — the request exactly as it was sent. */
    expect(calls).toEqual([{ path: "/api/generate/check", key: null, body: { key: STALE.key, endpoint: "/api/generate", body: STALE.body } }]);
    expect(readPendingGeneration(storage, STORAGE_ID)).toBeNull();
  });
});

for (const lost of ["absent", "refused"] as const) {
  test(`a lost attempt the server reports ${lost} is let go, and the edited request goes once under a new key at the price on the button`, async () => {
    const storage = memory();
    claimPendingGeneration(storage, STORAGE_ID, STALE);
    await withServer({
      "/api/generate/check": () => ({ json: lost === "absent" ? { state: "absent" } : { state: "refused", status: 400, error: "Prompt is required" } }),
      "/api/generate/quote": quote,
      "/api/generate": () => ({ status: 202, json: { id: "gen_edited", status: "queued" } }),
    }, async (calls) => {
      const claimed: number[] = [];
      const outcome = await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() }, onClaim: (c) => claimed.push(c) });
      expect(outcome).toEqual({ state: "queued", jobId: "gen_edited", credits: 21 });
      expect(calls.map((c) => c.path)).toEqual(["/api/generate/check", "/api/generate/quote", "/api/generate"]);
      const sent = calls[2];
      expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
      expect(sent.key).not.toBe(STALE.key);
      expect(sent.body).toMatchObject({ prompt: "Close on her hands.", duration: 6, maxCredits: 21, quoteFingerprint: "f".repeat(64) });
      expect(claimed).toEqual([21]);
      expect(readPendingGeneration(storage, STORAGE_ID)).toBeNull();
    });
  });
}

test("the Rig's own settle says what became of a lost attempt, and clears it only when it is final", async () => {
  const answers: [unknown, { state: string; reason?: string }, boolean][] = [
    [{ state: "absent" }, { state: "lost", reason: "Your last Generate never reached the server. Nothing was charged for it." }, false],
    [{ state: "refused", status: 402, error: "Not enough credits" }, { state: "lost", reason: "Your last Generate was refused. Nothing was charged for it." }, false],
    [{ state: "pending" }, { state: "unknown", reason: "Your last Generate is still being accepted. Nothing new was sent; press Generate again in a moment." }, true],
  ];
  for (const [reply, settled, kept] of answers) {
    const storage = memory();
    claimPendingGeneration(storage, STORAGE_ID, STALE);
    await withServer({ "/api/generate/check": () => ({ json: reply }) }, async () => {
      expect(await settlePendingGeneration({ scope: SCOPE, storageId: STORAGE_ID, storage })).toEqual(settled);
      expect(readPendingGeneration(storage, STORAGE_ID)?.key ?? null).toBe(kept ? STALE.key : null);
    });
  }
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_landed", status: "queued" } }) }, async () => {
    const storage = memory();
    claimPendingGeneration(storage, STORAGE_ID, STALE);
    expect(await settlePendingGeneration({ scope: SCOPE, storageId: STORAGE_ID, storage })).toEqual({ state: "landed", jobId: "gen_landed", status: "queued", credits: 18, model: ENGINE });
  });
  /* Nothing claimed: nothing is asked. */
  await withServer({}, async (calls) => {
    expect(await settlePendingGeneration({ scope: SCOPE, storageId: STORAGE_ID, storage: memory() })).toEqual({ state: "none" });
    expect(calls).toEqual([]);
  });
});

test("a lost attempt whose fate cannot be read yet sends nothing and keeps its claim for the next press", async () => {
  const replies: Answer[] = [
    { json: { state: "pending" } },
    "network",
    { status: 503, json: { error: "Unavailable" } },
    { status: 409, json: { error: "This Idempotency-Key names a different request." } },
    { json: { state: "landed" } },
  ];
  for (const reply of replies) {
    const storage = memory();
    claimPendingGeneration(storage, STORAGE_ID, STALE);
    await withServer({ "/api/generate/check": () => reply }, async (calls) => {
      const outcome = await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() } });
      expect(outcome.state).toBe("refused");
      expect(outcome.state === "refused" && outcome.reason).toMatch(/Nothing new was sent; press Generate again in a moment\.$/);
      expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
      expect(readPendingGeneration(storage, STORAGE_ID)?.key).toBe(STALE.key);
    });
  }
});

test("unreadable recovery storage never becomes a new paid attempt", async () => {
  const storage = memory();
  storage.setItem(STORAGE_ID, "{not json");
  await withServer({}, async (calls) => {
    const outcome = await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() } });
    expect(outcome).toEqual({ state: "refused", reason: "The saved generation request cannot be read. Check Activity before starting another take." });
    expect(calls).toEqual([]);
  });
});

test("another window's claim made while this one was quoting is never sent from here", async () => {
  const storage = memory();
  const theirs = { key: "other-window-0001", body: JSON.stringify({ prompt: "Theirs", model: ENGINE }), credits: 21, endpoint: "/api/generate" as const };
  await withServer({
    "/api/generate/quote": () => { claimPendingGeneration(storage, STORAGE_ID, theirs); return quote(); },
  }, async (calls) => {
    const outcome = await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() } });
    expect(outcome).toEqual({ state: "refused", reason: "Another Generate of this is already on its way. Nothing new was sent." });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
    expect(readPendingGeneration(storage, STORAGE_ID)?.key).toBe(theirs.key);
  });
});

test("with nothing claimed, a Generate is quoted, held to the price on the button, and sent once", async () => {
  await withServer({ "/api/generate/quote": quote, "/api/generate": () => ({ status: 202, json: { id: "gen_new" } }) }, async (calls) => {
    const storage = memory();
    expect(await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 20, storage, request: { endpoint: "/api/generate", input: edited() } }))
      .toEqual({ state: "repriced", credits: 21, reason: "The price is now 21 cr. Press it again to approve it." });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
    expect(await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() } }))
      .toEqual({ state: "queued", jobId: "gen_new", credits: 21 });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate/quote", "/api/generate"]);
    expect(readPendingGeneration(storage, STORAGE_ID)).toBeNull();
  });
});

/* The rate-table Rig (the phone board's Apply, the canvas's Run node) prices its own request and sends
   that price as its ceiling, under a stored Idempotency-Key (sendClaimedGeneration). */
const RERENDER = { prompt: "Rowan crosses the ice", model: ENGINE, projectId: "prj_1", shotId: "sh1", ratio: "16:9", resolution: "1080p", duration: 5, maxCredits: 19 };
const SLOT = pendingGenerationKey(SCOPE, "prj_1", "rig-apply:sh1");
const LOST_SEND = { key: "lost-send-00001", body: JSON.stringify(RERENDER), credits: 19, endpoint: "/api/generate" as const };

test("a claimed send stores its key before it posts, with the workspace scope, and a lost reply keeps the claim for the next press", async () => {
  const storage = memory();
  await withServer({ "/api/generate": () => "network" }, async (calls) => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage })).toMatchObject({ state: "unknown", lost: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/generate", body: RERENDER });
    expect(calls[0].key).toMatch(/^[0-9a-f-]{36}$/);
    expect(readPendingGeneration(storage, SLOT)).toEqual({ key: calls[0].key, body: JSON.stringify(RERENDER), credits: 19, endpoint: "/api/generate" });
  });
  /* Answered: the claim goes, and the job is the caller's to follow. */
  const fresh = memory();
  await withServer({ "/api/generate": () => ({ status: 202, json: { id: "gen_new", status: "queued" } }) }, async (calls) => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage: fresh }))
      .toEqual({ state: "queued", jobId: "gen_new", status: "queued", credits: 19, followed: false });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate"]);
    expect(readPendingGeneration(fresh, SLOT)).toBeNull();
  });
});

test("the next press asks about a lost send first: landed is followed and nothing is posted, never arrived posts once under a new key, not known posts nothing", async () => {
  const landed = memory();
  claimPendingGeneration(landed, SLOT, LOST_SEND);
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_lost", status: "running" } }) }, async (calls) => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage: landed }))
      .toEqual({ state: "queued", jobId: "gen_lost", status: "running", credits: 19, followed: true });
    expect(calls).toEqual([{ path: "/api/generate/check", key: null, body: { key: LOST_SEND.key, endpoint: "/api/generate", body: LOST_SEND.body } }]);
    expect(readPendingGeneration(landed, SLOT)).toBeNull();
  });
  const absent = memory();
  claimPendingGeneration(absent, SLOT, LOST_SEND);
  await withServer({ "/api/generate/check": () => ({ json: { state: "absent" } }), "/api/generate": () => ({ status: 202, json: { id: "gen_new" } }) }, async (calls) => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage: absent })).toMatchObject({ state: "queued", jobId: "gen_new", followed: false });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check", "/api/generate"]);
    expect(calls[1].key).not.toBe(LOST_SEND.key);
  });
  const pending = memory();
  claimPendingGeneration(pending, SLOT, LOST_SEND);
  await withServer({ "/api/generate/check": () => ({ json: { state: "pending" } }) }, async (calls) => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage: pending })).toMatchObject({ state: "unknown", lost: false });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
    expect(readPendingGeneration(pending, SLOT)?.key).toBe(LOST_SEND.key);
  });
});

test("a final refusal lets a claimed send go; one that is not final keeps it; a server error is not known", async () => {
  const cases: [Answer, { state: string }, boolean][] = [
    [{ status: 409, json: { error: "The generation estimate changed." }, headers: { "Idempotency-Status": "complete" } }, { state: "refused" }, false],
    [{ status: 402, json: { id: "gen_failed", status: "failed", error: "Not enough credits" } }, { state: "refused" }, false],
    [{ status: 409, json: { error: "Your account or workspace changed." } }, { state: "refused" }, true],
    [{ status: 503, json: { error: "The request was interrupted." } }, { state: "unknown" }, true],
  ];
  for (const [answer, outcome, kept] of cases) {
    const storage = memory();
    await withServer({ "/api/generate": () => answer }, async () => {
      expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage })).toMatchObject(outcome);
      expect(Boolean(readPendingGeneration(storage, SLOT)), JSON.stringify(answer)).toBe(kept);
    });
  }
});

/* A stored request that is not a dispatch claim (the Make composer's batch takes and audio): asked about by its key,
   and re-quoted before it may go again, only at exactly the price approved for it (settleStoredRequest). */
const STORED = { key: "stored-take-0001", body: JSON.stringify({ prompt: "A brass key.", model: ENGINE, maxCredits: 3, variation: 2 }) };

test("a stored request that landed is followed, and nothing is quoted or sent", async () => {
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_2", status: "running" } }) }, async (calls) => {
    expect(await settleStoredRequest({ scope: SCOPE, ...STORED, endpoint: "/api/generate", approved: { price: 3, unit: "cr" } }))
      .toEqual({ state: "landed", jobId: "gen_2", status: "running" });
    expect(calls).toEqual([{ path: "/api/generate/check", key: null, body: { key: STORED.key, endpoint: "/api/generate", body: STORED.body } }]);
  });
});

test("a stored request that never arrived may go again only at exactly its approved price; a moved price is reported, not sent", async () => {
  for (const [price, outcome] of [[3, { state: "resend" }], [2, { state: "repriced", price: 2, unit: "cr", credits: 2 }], [4, { state: "repriced", price: 4, unit: "cr", credits: 4 }]] as const) {
    await withServer({
      "/api/generate/check": () => ({ json: { state: "absent" } }),
      "/api/generate/quote": (body) => {
        expect(body).toEqual(JSON.parse(STORED.body));
        return { json: { estimatedCredits: price, price, unit: "cr", fingerprint: "f".repeat(64) } };
      },
    }, async (calls) => {
      expect(await settleStoredRequest({ scope: SCOPE, ...STORED, endpoint: "/api/generate", approved: { price: 3, unit: "cr" } })).toEqual(outcome);
      expect(calls.map((c) => c.path)).toEqual(["/api/generate/check", "/api/generate/quote"]);
    });
  }
  /* Audio is re-quoted by its own route; dollars are compared to the cent. */
  const audio = { key: "stored-audio-0001", body: JSON.stringify({ task: "speech", text: "A line.", maxCredits: 21 }) };
  await withServer({
    "/api/generate/check": () => ({ json: { state: "refused", status: 402, error: "Not enough credits" } }),
    "/api/audio": (body) => ({ json: body.quoteOnly ? { estimatedCredits: 21, price: 2.1, unit: "usd" } : { error: "not a quote" } }),
  }, async (calls) => {
    expect(await settleStoredRequest({ scope: SCOPE, ...audio, endpoint: "/api/audio", approved: { price: 2.1000000001, unit: "usd" } })).toEqual({ state: "resend" });
    expect(calls[1]).toMatchObject({ path: "/api/audio", body: { task: "speech", text: "A line.", maxCredits: 21, quoteOnly: true } });
  });
  /* A key already known to be refused is only re-quoted. */
  await withServer({ "/api/generate/quote": () => ({ json: { estimatedCredits: 3, price: 3, unit: "cr" } }) }, async (calls) => {
    expect(await settleStoredRequest({ scope: SCOPE, ...STORED, endpoint: "/api/generate", approved: { price: 3, unit: "cr" }, ask: false })).toEqual({ state: "resend" });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
  });
});

test("a stored request whose fate or price cannot be read sends nothing", async () => {
  const cases: Record<string, (body: Record<string, unknown>) => Answer>[] = [
    { "/api/generate/check": () => ({ json: { state: "pending" } }) },
    { "/api/generate/check": () => "network" },
    { "/api/generate/check": () => ({ json: { state: "absent" } }), "/api/generate/quote": () => "network" },
    { "/api/generate/check": () => ({ json: { state: "absent" } }), "/api/generate/quote": () => ({ json: { estimatedCredits: 2.5, price: 2.5, unit: "cr" } }) },
  ];
  for (const routes of cases)
    await withServer(routes, async () => {
      expect((await settleStoredRequest({ scope: SCOPE, ...STORED, endpoint: "/api/generate", approved: { price: 3, unit: "cr" } })).state).toBe("unknown");
    });
});

test("the quote route's word on a body its caller prices itself: only its own \"no confirmed price\" answer is unpriced", async () => {
  /* The rate-table Rig's Run node: the body it would send, less its ceiling. Asking sends nothing and claims nothing. */
  const body = { prompt: "Wide. Hold still.", model: ENGINE, projectId: "prod_1", resolution: "720p", ratio: "adaptive", duration: 5 };
  const answers: [Answer, QuoteCheck][] = [
    [{ json: { estimatedCredits: 21, price: 21, unit: "cr", fingerprint: "f".repeat(64) } }, "priced"],
    [{ status: 400, json: { error: "This model has no confirmed price." } }, "unpriced"],
    [{ status: 503, json: { error: "Identity rendering has no confirmed price for this size." } }, "unpriced"],
    /* Any other refusal is the paid route's to give, the same way. */
    [{ status: 400, json: { error: "Prompt is required" } }, "refused"],
    [{ status: 403, json: { error: "A current workspace member must approve this generation." } }, "refused"],
    [{ status: 429, json: { error: "This workspace has started 60 renders in the last hour, its limit." } }, "refused"],
    /* No answer to go on. */
    [{ status: 500, json: { error: "The database is busy." } }, "failed"],
    [{ json: { estimatedCredits: "21" } }, "failed"],
    ["network", "failed"],
  ];
  for (const [answer, verdict] of answers)
    await withServer({ "/api/generate/quote": () => answer }, async (calls) => {
      expect(await checkQuote(SCOPE, body)).toBe(verdict);
      expect(calls).toEqual([{ path: "/api/generate/quote", key: null, body }]);
    });
});

test("a claim stored without its route (the Make composer's audio) is checked against the route it names", async () => {
  const storage = memory();
  storage.setItem(STORAGE_ID, JSON.stringify({ key: "audio-claim-0001", body: JSON.stringify({ task: "speech", text: "A line." }), credits: 21 }));
  await withServer({ "/api/generate/check": () => ({ json: { state: "absent" } }) }, async (calls) => {
    expect(await settlePendingGeneration({ scope: SCOPE, storageId: STORAGE_ID, storage, endpoint: "/api/audio" })).toMatchObject({ state: "lost" });
    expect(calls[0].body).toMatchObject({ key: "audio-claim-0001", endpoint: "/api/audio" });
  });
});

/* ── Viral and Business › Image ads on the API key: the same dispatch, no path of their own ── */

const transform = () => viralRequest(
  { variant: "motion-transfer", resolution: "720p", prompt: "Keep the hands.", source: { uploadId: "src" }, references: [{ uploadId: "b" }, { genId: "a" }] },
  { id: "draft-1", productionProjectId: "prod_1" },
);
const TRANSFORM_BODY = {
  model: GENJUTSU_MODELS["motion-transfer"], task: "genjutsu", sourceUploadId: "src",
  references: [{ uploadId: "b", role: "reference_image" }, { genId: "a", role: "reference_image" }],
  resolution: "720p", prompt: "Keep the hands.", projectId: "prod_1", workbenchProjectId: "draft-1", refine: false,
};

test("a Viral transform is priced exactly as it will be sent, held to the button, claimed, and sent once with its approval", async () => {
  const storage = memory(), storageId = pendingGenerationKey(SCOPE, "draft-1", "viral:motion-transfer");
  await withServer({ "/api/generate/quote": quote, "/api/generate": () => ({ status: 202, json: { id: "gen_transform", status: "queued" } }) }, async (calls) => {
    const outcome = await dispatchGeneration({ scope: SCOPE, storageId, shown: 21, storage, request: transform() });
    expect(outcome).toEqual({ state: "queued", jobId: "gen_transform", credits: 21 });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate"]);
    expect(calls[0].body).toEqual(TRANSFORM_BODY);
    expect(calls[1].body).toEqual({ ...TRANSFORM_BODY, maxCredits: 21, quoteFingerprint: "f".repeat(64) });
    expect(calls[1].key).toMatch(/^[0-9a-f-]{36}$/);
    expect(readPendingGeneration(storage, storageId)).toBeNull();
  });
});

test("a transform whose price moved, or that the route refuses, sends nothing", async () => {
  const storage = memory(), storageId = pendingGenerationKey(SCOPE, "draft-1", "viral:motion-transfer");
  await withServer({ "/api/generate/quote": () => ({ json: { estimatedCredits: 30, fingerprint: "e".repeat(64) } }) }, async (calls) => {
    expect(await dispatchGeneration({ scope: SCOPE, storageId, shown: 21, storage, request: transform() })).toMatchObject({ state: "repriced", credits: 30 });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
  });
  /* No estimate at all is refused: never a guessed price. */
  for (const refusal of [
    { status: 400, json: { error: "Choose one to eight original still references using saved media identities." } },
    { status: 503, json: { error: "A live transform price could not be verified. Nothing was submitted. Try a fresh quote.", code: "price_unavailable" } },
  ]) await withServer({ "/api/generate/quote": () => refusal }, async (calls) => {
    expect(await dispatchGeneration({ scope: SCOPE, storageId, shown: 21, storage, request: transform() })).toEqual({ state: "refused", reason: refusal.json.error });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
    expect(readPendingGeneration(storage, storageId)).toBeNull();
  });
});

test("a transform whose reply was lost is asked about by its own key on the next press, never sent again", async () => {
  const storage = memory(), storageId = pendingGenerationKey(SCOPE, "draft-1", "viral:motion-transfer");
  await withServer({ "/api/generate/quote": quote, "/api/generate": () => "network" }, async () => {
    expect(await dispatchGeneration({ scope: SCOPE, storageId, shown: 21, storage, request: transform() })).toMatchObject({ state: "refused" });
  });
  const claim = readPendingGeneration(storage, storageId)!;
  expect(JSON.parse(claim.body)).toEqual({ ...TRANSFORM_BODY, maxCredits: 21, quoteFingerprint: "f".repeat(64) });
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_landed", status: "running" } }) }, async (calls) => {
    expect(await dispatchGeneration({ scope: SCOPE, storageId, shown: 21, storage, request: transform() })).toEqual({ state: "queued", jobId: "gen_landed", credits: 21 });
    expect(calls).toEqual([{ path: "/api/generate/check", key: null, body: { key: claim.key, endpoint: "/api/generate", body: claim.body } }]);
  });
});

test("an Image ad goes through the same dispatch: the key model's body, priced as sent, sent once with its approval", async () => {
  const storage = memory(), storageId = pendingGenerationKey(SCOPE, "draft-1", "business:image-ads");
  const request = imageAdRequest({ ...INITIAL_IMAGE_AD, prompt: "Bold hero shot", productStill: { id: "upload:p", name: "p", sourceId: "p", origin: "upload", url: "/api/uploads/p" } }, { productionProjectId: "prod_1" });
  await withServer({ "/api/generate/quote": quote, "/api/generate": () => ({ status: 202, json: { id: "gen_ad", status: "held" } }) }, async (calls) => {
    /* Held for credits is a real job, not a charge: it starts when credits arrive. */
    expect(await dispatchGeneration({ scope: SCOPE, storageId, shown: 21, storage, request })).toEqual({ state: "queued", jobId: "gen_ad", credits: 21, status: "held" });
    expect(calls[0].body).toEqual({ prompt: "Bold hero shot", model: MARKETING_IMAGE_MODEL_ID, projectId: "prod_1", ratio: "1:1", resolution: "2k", refine: false, references: [{ uploadId: "p", role: "reference_image" }], marketing: { quality: "high", enhancePrompt: false } });
    expect(calls[1].body).toMatchObject({ maxCredits: 21, quoteFingerprint: "f".repeat(64), marketing: { quality: "high", enhancePrompt: false } });
  });
});


/* ── Two tabs, one lost reply ─────────────────────────────────────────────
   Tab A's paid POST lands but its reply is lost (its claim stays). Tab B's press settles that claim and lets it go. Tab A's
   next press must not quote and send anew: it settles its own copy of the claim (the note B left, else the same check). */
const SETTLED = "particl:settled-generations:v1";
/** One tab's view of the browser's shared storage: the same items, its own tab store (lib/workbench/pending-generation › tabStorage). */
const tabOf = (shared: ReturnType<typeof memory>) => ({ getItem: (k: string) => shared.getItem(k), setItem: (k: string, v: string) => shared.setItem(k, v), removeItem: (k: string) => shared.removeItem(k) });
const press = (storage: ReturnType<typeof tabOf>) => dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() } });

async function lostInTabA(shared: ReturnType<typeof memory>) {
  const a = tabOf(shared);
  let k1 = "";
  await withServer({ "/api/generate/quote": quote, "/api/generate": () => ({ status: 503, json: { error: "The request was interrupted." } }) }, async (calls) => {
    expect((await press(a)).state).toBe("refused");
    k1 = calls[1].key!;
  });
  expect(readPendingGeneration(shared, STORAGE_ID)?.key).toBe(k1);
  return { a, k1 };
}

test("two tabs: after another tab settled this tab's lost request as landed, this tab's next press follows that job and sends nothing", async () => {
  const shared = memory();
  const { a, k1 } = await lostInTabA(shared);
  const b = tabOf(shared);
  await withServer({ "/api/generate/check": (body) => ({ json: body.key === k1 ? { state: "landed", id: "gen_k1", status: "running" } : { state: "absent" } }) }, async (calls) => {
    expect(await press(b)).toEqual({ state: "queued", jobId: "gen_k1", credits: 21 });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
  });
  expect(readPendingGeneration(shared, STORAGE_ID)).toBeNull();
  /* Tab A: B's note answers; nothing is asked, quoted or sent. */
  await withServer({}, async (calls) => {
    expect(await press(a)).toEqual({ state: "queued", jobId: "gen_k1", credits: 21 });
    expect(calls).toEqual([]);
  });
  /* Settled for A too now: A's next press is a new take, and so is B's. */
  for (const tab of [a, b]) {
    await withServer({ "/api/generate/quote": quote, "/api/generate": () => ({ status: 202, json: { id: "gen_new" } }) }, async (calls) => {
      expect(await press(tab)).toEqual({ state: "queued", jobId: "gen_new", credits: 21 });
      expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate"]);
      expect(calls[1].key).not.toBe(k1);
    });
  }
});

test("two tabs: without the note (expired, or never written), this tab asks the server by its own key before anything else", async () => {
  for (const how of ["expired", "missing"] as const) {
    const shared = memory();
    const { a, k1 } = await lostInTabA(shared);
    await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_k1", status: "queued" } }) }, async () => { expect((await press(tabOf(shared))).state).toBe("queued"); });
    const note = JSON.parse(shared.getItem(SETTLED)!) as Record<string, { at: number }>;
    expect(Object.keys(note)).toEqual([k1]);
    if (how === "expired") shared.setItem(SETTLED, JSON.stringify({ [k1]: { ...note[k1], at: Date.now() - SETTLED_MS - 1 } }));
    else shared.removeItem(SETTLED);
    await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_k1", status: "running" } }) }, async (calls) => {
      expect(await press(a)).toEqual({ state: "queued", jobId: "gen_k1", credits: 21 });
      expect(calls).toEqual([{ path: "/api/generate/check", key: null, body: { key: k1, endpoint: "/api/generate", body: expect.any(String) } }]);
    });
  }
});

test("two tabs: this tab's own copy whose fate cannot be read yet sends nothing and is kept", async () => {
  const shared = memory();
  const { a, k1 } = await lostInTabA(shared);
  /* Another tab let the claim go without a note this tab can read. */
  shared.removeItem(STORAGE_ID);
  for (const reply of [{ json: { state: "pending" } }, "network"] as Answer[]) {
    await withServer({ "/api/generate/check": () => reply }, async (calls) => {
      const outcome = await press(a);
      expect(outcome.state).toBe("refused");
      expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
      expect(calls[0].body.key).toBe(k1);
    });
  }
  expect(readOwnClaim(a, STORAGE_ID)?.key).toBe(k1);
});

test("two tabs: a lost request another tab found never arrived is let go here too, and this press goes once under a new key", async () => {
  const shared = memory();
  const { a, k1 } = await lostInTabA(shared);
  await withServer({ "/api/generate/check": () => ({ json: { state: "absent" } }), "/api/generate/quote": quote, "/api/generate": () => ({ status: 202, json: { id: "gen_b" } }) }, async () => {
    expect(await press(tabOf(shared))).toEqual({ state: "queued", jobId: "gen_b", credits: 21 });
  });
  await withServer({ "/api/generate/quote": quote, "/api/generate": () => ({ status: 202, json: { id: "gen_a" } }) }, async (calls) => {
    expect(await press(a)).toEqual({ state: "queued", jobId: "gen_a", credits: 21 });
    /* B's note said it never arrived (fenced): nothing to ask, and this press is quoted and sent once. */
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate"]);
    expect(calls[1].key).not.toBe(k1);
  });
  expect(readOwnClaim(a, STORAGE_ID)).toBeNull();
});

test("a claimed send (the rate-table Rig) settles its own copy the same way after another tab let the claim go", async () => {
  const shared = memory();
  const a = tabOf(shared), b = tabOf(shared);
  let k1 = "";
  await withServer({ "/api/generate": () => "network" }, async (calls) => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage: a })).toMatchObject({ state: "unknown", lost: true });
    k1 = calls[0].key!;
  });
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_k1", status: "running" } }) }, async () => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage: b })).toMatchObject({ state: "queued", jobId: "gen_k1", followed: true });
  });
  await withServer({}, async (calls) => {
    expect(await sendClaimedGeneration({ scope: SCOPE, storageId: SLOT, body: RERENDER, credits: 19, storage: a })).toEqual({ state: "queued", jobId: "gen_k1", status: "running", credits: 19, followed: true });
    expect(calls).toEqual([]);
  });
  expect(k1).toBeTruthy();
});
