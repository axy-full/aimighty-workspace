import { test, expect } from "@playwright/test";
import { dispatchGeneration, settlePendingGeneration } from "../../lib/workspace/generate-submit";
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
type Answer = { status?: number; json: unknown } | "network";
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
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "Content-Type": "application/json" } });
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
