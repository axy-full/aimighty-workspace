import { test, expect } from "@playwright/test";
import { dispatchGeneration, sendClaimedGeneration, settlePendingGeneration, settleStoredRequest } from "../../lib/workspace/generate-submit";
import { claimPendingGeneration, pendingGenerationKey, readPendingGeneration } from "../../lib/workbench/pending-generation";
import type { GenerationBodyInput } from "../../lib/workbench/generation-request";

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
      .toEqual({ state: "repriced", credits: 21, reason: "The price is now 21 cr. Press Generate again to approve it." });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
    expect(await dispatchGeneration({ scope: SCOPE, storageId: STORAGE_ID, shown: 21, storage, request: { endpoint: "/api/generate", input: edited() } }))
      .toEqual({ state: "queued", jobId: "gen_new", credits: 21 });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate/quote", "/api/generate"]);
    expect(readPendingGeneration(storage, STORAGE_ID)).toBeNull();
  });
});

/* The rate-table Rig (the phone board's Apply, the canvas's Run node) prices its own request and sends
   that price as its ceiling, under a stored Idempotency-Key (sendClaimedGeneration). */
const RERENDER = { prompt: "Iver crosses the ice", model: ENGINE, projectId: "prj_1", shotId: "sh1", ratio: "16:9", resolution: "1080p", duration: 5, maxCredits: 19 };
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

test("a claim stored without its route (the Make composer's audio) is checked against the route it names", async () => {
  const storage = memory();
  storage.setItem(STORAGE_ID, JSON.stringify({ key: "audio-claim-0001", body: JSON.stringify({ task: "speech", text: "A line." }), credits: 21 }));
  await withServer({ "/api/generate/check": () => ({ json: { state: "absent" } }) }, async (calls) => {
    expect(await settlePendingGeneration({ scope: SCOPE, storageId: STORAGE_ID, storage, endpoint: "/api/audio" })).toMatchObject({ state: "lost" });
    expect(calls[0].body).toMatchObject({ key: "audio-claim-0001", endpoint: "/api/audio" });
  });
});
