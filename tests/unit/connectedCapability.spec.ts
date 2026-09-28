import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  ALTERNATIVE_LABEL, CAPABILITY_FRESH_MS, CAPABILITY_UNREADABLE, CONNECTED_PROVIDER, OWNER_RUNS, OWNER_RUN_LEGACY_SUITES, OWNER_RUN_PAGES, OWNER_RUN_SUITES,
  alternativePrice, capabilityOf, castStillPrompt, connectionFrom, createCapabilityStore, isOwnerRunPage, isOwnerRunSuite, ownerBadgeNote, ownerRunBy,
  ownerRunEyebrow, ownerRunTitle, runsOnOwnerAccount, ownerAccountPlans, type ConnectionReply,
} from "../../lib/shell/connected-capability";
import { OWN_PAGES } from "../../lib/shell/business-own";
import { SHELL_SUITES } from "../../lib/shell/ia";
import { REACH_REUSE_MS, createReachMemory, reachConnection, reachStateFrom, type ReachState } from "../../lib/shell/tools-connections";
import { CONNECTED_REACH } from "../../lib/higgsfield-consumer/reach";
import { INITIAL_COMPOSER, activeModel, composerBlock, workspaceModels, type EngineRow } from "../../lib/workspace/composer";
import { rowPrice } from "../../lib/workspace/model-picker";
import { PLANS } from "../../lib/workspace/plans";
import { AtomikRunEngine } from "../../lib/workspace/run-engine";

/**
 * Idea 19 — who runs the connected account, read once per scope and shared.
 * The owner alone connects and spends through it (every
 * /api/higgsfield/consumer route is owner-only), so a member's surfaces are
 * decided from the session and read nothing; the owner's connection is one
 * read per scope, deduplicated, reused while fresh, re-read behind the answer
 * on screen; a failed read is an error to retry, never a demotion to member;
 * and a connect or disconnect busts the scope so no answer from before it
 * comes back.
 */

/** A read the test answers by hand, with a clock it moves. */
function harness() {
  let now = 1_000_000;
  const calls: string[] = [];
  const pending: { resolve: (reply: ConnectionReply) => void; reject: (error: unknown) => void }[] = [];
  const store = createCapabilityStore((scope) => { calls.push(scope); return new Promise<ConnectionReply>((resolve, reject) => pending.push({ resolve, reject })); }, () => now);
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { store, calls, pending, flush, tick: (ms: number) => { now += ms; } };
}

test("the connection is read once per scope: surfaces opening together share one read, a fresh answer is reused", async () => {
  const { store, calls, pending, flush, tick } = harness();
  let heard = 0;
  store.subscribe(() => heard++);
  const a = store.ensure("scope-a");
  const b = store.ensure("scope-a");
  expect(a).toBe(b);
  expect(store.get("scope-a")?.status).toBe("loading");
  await flush();
  expect(calls).toEqual(["scope-a"]);
  pending[0].resolve({ connected: true, requiresReconnect: false });
  await a;
  expect(store.get("scope-a")).toMatchObject({ status: "ready", connected: true, reconnect: false, error: null });
  expect(heard).toBeGreaterThanOrEqual(2);

  /* Fresh: a surface opened a moment later reads nothing. */
  tick(CAPABILITY_FRESH_MS - 1);
  await store.ensure("scope-a");
  await flush();
  expect(calls).toEqual(["scope-a"]);

  /* Another person or workspace is another scope, with its own read. */
  void store.ensure("scope-b");
  await flush();
  expect(calls).toEqual(["scope-a", "scope-b"]);
  expect(store.get("scope-a")?.connected).toBe(true);
});

test("a stale answer stays while reading, but a failed re-read blocks connected work", async () => {
  const { store, calls, pending, flush, tick } = harness();
  const first = store.ensure("s");
  await flush();
  pending[0].resolve({ connected: true });
  await first;
  tick(CAPABILITY_FRESH_MS + 1);
  const again = store.ensure("s");
  /* No loading flash: the old answer is what surfaces render meanwhile. */
  expect(store.get("s")).toMatchObject({ status: "ready", connected: true });
  await flush();
  expect(calls).toHaveLength(2);
  pending[1].reject(new Error("The connected account is temporarily unavailable."));
  await again;
  expect(store.get("s")).toMatchObject({ status: "error", connected: false, error: "The connected account is temporarily unavailable." });
});

test("a failed first read is the owner's error to retry — never a demotion to member — and Try again reads at once", async () => {
  const { store, calls, pending, flush } = harness();
  const first = store.ensure("s");
  await flush();
  pending[0].reject(new Error("The connected account is temporarily unavailable."));
  await first;
  expect(store.get("s")).toMatchObject({ status: "error", error: "The connected account is temporarily unavailable.", connected: false });
  expect(capabilityOf(true, store.get("s"))).toMatchObject({ owner: true, status: "error" });

  /* A read error with no words of its own says the plain thing. */
  const retry = store.ensure("s", true);
  expect(store.get("s")?.status).toBe("loading");
  await flush();
  expect(calls).toHaveLength(2);
  pending[1].reject("socket closed");
  await retry;
  expect(store.get("s")?.error).toBe(CAPABILITY_UNREADABLE);

  /* Forced, a fresh answer is read again too. */
  const third = store.ensure("s", true);
  await flush();
  pending[2].resolve({ connected: false, requiresReconnect: true });
  await third;
  expect(store.get("s")).toMatchObject({ status: "ready", connected: false, reconnect: true });
  const fourth = store.ensure("s", true);
  await flush();
  expect(calls).toHaveLength(4);
  pending[3].resolve({ connected: true });
  await fourth;
});

test("a read that throws at once still settles, and the scope can be read again", async () => {
  let n = 0;
  const store = createCapabilityStore(() => { n++; if (n === 1) throw new Error("no network"); return Promise.resolve({ connected: true }); });
  await store.ensure("s");
  expect(store.get("s")).toMatchObject({ status: "error", error: "no network" });
  await store.ensure("s");
  expect(store.get("s")).toMatchObject({ status: "ready", connected: true });
  expect(n).toBe(2);
});

test("a surface whose own reply carries the connection settles the shared answer; nothing more is read", async () => {
  const { store, calls, flush } = harness();
  store.settle("s", { connected: true, requiresReconnect: false });
  await store.ensure("s");
  await flush();
  expect(calls).toEqual([]);
  expect(store.get("s")).toMatchObject({ status: "ready", connected: true });
});

test("a disconnect busts the scope: the next surface reads afresh, and no answer from before it comes back", async () => {
  const { store, calls, pending, flush } = harness();
  let heard = 0;
  store.subscribe(() => heard++);
  const first = store.ensure("s");
  await flush();
  pending[0].resolve({ connected: true });
  await first;

  /* A read, and a surface's own read, set out while the account was still connected… */
  const stale = store.ensure("s", true);
  const since = store.mark("s");
  await flush();
  expect(calls).toHaveLength(2);
  /* …then the owner disconnects in Engines: the answer on screen goes, and every surface hears it. */
  const before = heard;
  store.bust("s");
  expect(store.get("s")).toBeUndefined();
  expect(heard).toBe(before + 1);
  expect(capabilityOf(true, store.get("s"))).toMatchObject({ status: "loading" });

  /* Engines reads the new state and settles it. */
  const fresh = store.mark("s");
  store.settle("s", { connected: false, requiresReconnect: false }, fresh);
  expect(store.get("s")).toMatchObject({ status: "ready", connected: false });

  /* The answers that set out before the disconnect land late, and are dropped. */
  pending[1].resolve({ connected: true });
  await stale;
  store.settle("s", { connected: true }, since);
  expect(store.get("s")).toMatchObject({ status: "ready", connected: false });

  /* A bust while nothing is known is quiet, and the next read after a bust is a new read. */
  store.bust("other");
  store.bust("s");
  const after = store.ensure("s");
  await flush();
  expect(calls).toHaveLength(3);
  pending[2].resolve({ connected: true, requiresReconnect: true });
  await after;
  expect(store.get("s")).toMatchObject({ status: "ready", connected: false, reconnect: true });
});

test("a newer surface answer supersedes an older connection request still in flight", async () => {
  const { store, pending, flush } = harness();
  const old = store.ensure("s");
  await flush();
  store.settle("s", { connected: false }, store.mark("s"));
  pending[0].resolve({ connected: true });
  await old;
  expect(store.get("s")).toMatchObject({ status: "ready", connected: false });
});

test("a late pre-disconnect response cannot overwrite or clear the new read in flight", async () => {
  const { store, pending, flush, calls } = harness();
  const old = store.ensure("s");
  const beforeDisconnect = store.mark("s");
  await flush();
  store.bust("s");
  const fresh = store.ensure("s");
  await flush();
  pending[0].resolve({ connected: true });
  await old;
  expect(store.settle("s", { connected: true }, beforeDisconnect)).toBe(false);
  expect(store.get("s")).toMatchObject({ status: "loading", connected: false });
  expect(store.ensure("s")).toBe(fresh);
  expect(calls).toEqual(["s", "s"]);
  pending[1].resolve({ connected: false });
  await fresh;
  expect(store.get("s")).toMatchObject({ status: "ready", connected: false });
});

test("a disconnect in one workspace does not change another workspace's capability", () => {
  const { store } = harness();
  store.settle("studio-a", { connected: true });
  store.settle("studio-b", { connected: true });
  const before = store.mark("studio-a");
  store.bust("studio-a");
  expect(store.settle("studio-a", { connected: true }, before)).toBe(false);
  expect(store.get("studio-a")).toBeUndefined();
  expect(store.get("studio-b")).toMatchObject({ connected: true });
});

test("the connection reads as connected only when it needs nothing first; a lapsed grant is a reconnect", () => {
  expect(connectionFrom({ connected: true, requiresReconnect: false })).toEqual({ connected: true, reconnect: false });
  expect(connectionFrom({ connected: true, requiresReconnect: true })).toEqual({ connected: false, reconnect: true });
  expect(connectionFrom({ connected: false })).toEqual({ connected: false, reconnect: false });
  expect(connectionFrom({ connected: "yes" })).toEqual({ connected: false, reconnect: false });
  expect(connectionFrom(null)).toEqual({ connected: false, reconnect: false });
});

test("a member is decided from the session: never loading, never connected, and the owner is named when the session names them", () => {
  const answered = { status: "ready" as const, connected: true, reconnect: false, error: null, at: 1 };
  /* Whatever the store holds for the scope, a member's capability is the member's. */
  expect(capabilityOf(false, answered, "  Harbour Owner ")).toEqual({ owner: false, status: "member", connected: false, reconnect: false, error: null, ownerName: "Harbour Owner" });
  expect(capabilityOf(false, undefined, "").ownerName).toBeNull();
  expect(capabilityOf(true, undefined)).toMatchObject({ owner: true, status: "loading", connected: false });
  expect(capabilityOf(true, answered, "Harbour Owner")).toMatchObject({ owner: true, status: "ready", connected: true, ownerName: null });
});

test("a member's words: who runs the provider-account tools by name, what runs there, and the workspace-credit way", () => {
  expect(CONNECTED_PROVIDER).toBe("Higgsfield");
  expect(ownerRunBy("Harbour Owner")).toBe("Harbour Owner");
  expect(ownerRunBy("   ")).toBe("the workspace owner");
  expect(ownerRunBy(null)).toBe("the workspace owner");
  expect(ownerRunTitle("Harbour Owner")).toBe("Higgsfield-account tools are run by Harbour Owner");
  expect(ownerRunTitle(undefined)).toBe("Higgsfield-account tools are run by the workspace owner");
  expect(ownerBadgeNote("Harbour Owner")).toBe("Run by Harbour Owner on the Higgsfield account");
  expect(OWNER_RUNS.business.alternative).toMatchObject({ type: "image", action: "Open Gen · Images" });
  expect(OWNER_RUNS.viral.alternative).toMatchObject({ type: "video", action: "Open Gen · Video" });
  expect(OWNER_RUNS.cast.alternative).toMatchObject({ type: "image", action: "Open Gen · Images" });
  expect(OWNER_RUNS.cast.alternative?.what).toContain("Studio image engines");
  /* Dubbing, voice change and social cuts have no Studio engine that makes the same thing: no alternative is invented. */
  expect(OWNER_RUNS.workflows.alternative).toBeNull();
  expect(ownerRunEyebrow("workflows", ["Dub", "Change voice"])).toBe("Dub · Change voice");
  expect(ownerRunEyebrow("business")).toBe(OWNER_RUNS.business.eyebrow);
  expect(ALTERNATIVE_LABEL).toBe("On this workspace’s credits");
  for (const run of Object.values(OWNER_RUNS)) {
    /* One short line each, never a connect prompt a member cannot act on, never the account's credits. */
    expect(run.line.split(". ").length).toBe(1);
    for (const words of [run.line, run.eyebrow, run.alternative?.what ?? ""]) expect(words).not.toMatch(/\bConnect (it|the|one)\b|Engines ›|Workspace ›|connected cr|Higgsfield credits|\bbalance\b/i);
  }
  /* Viral runs on the owner's account on every page; Business only on Ads, Image ads and Setup — its own tools are everyone's. */
  expect(OWNER_RUN_SUITES).toEqual(["viral"]);
  expect(isOwnerRunSuite("viral")).toBe(true);
  expect(isOwnerRunSuite("business") || isOwnerRunSuite("studio") || isOwnerRunSuite("gen") || isOwnerRunSuite("atomik") || isOwnerRunSuite(null)).toBe(false);
  expect(OWNER_RUN_PAGES).toEqual({ business: ["ads", "dtc", "setup"] });
  for (const page of ["ads", "dtc", "setup"]) expect(isOwnerRunPage("business", page), page).toBe(true);
  for (const page of OWN_PAGES) expect(isOwnerRunPage("business", page), page).toBe(false);
  for (const page of ["motion", "swap", "history"]) expect(isOwnerRunPage("viral", page), page).toBe(true);
  expect(isOwnerRunPage("studio", "cast") || isOwnerRunPage("business", null) || isOwnerRunPage(null, "ads")).toBe(false);
  /* Every owner-run page names a page the suite really has. */
  for (const [suite, pages] of Object.entries(OWNER_RUN_PAGES)) for (const page of pages) expect(SHELL_SUITES.find((s) => s.id === suite)?.pages.some((p) => p.id === page), `${suite}/${page}`).toBe(true);
  /* The state layer's suites behind them are exactly the shell's suites with an owner-run page. */
  expect(SHELL_SUITES.filter((suite) => OWNER_RUN_SUITES.includes(suite.id) || OWNER_RUN_PAGES[suite.id]).map((suite) => suite.legacy).sort()).toEqual([...OWNER_RUN_LEGACY_SUITES].sort());
});

test("the alternative is priced exactly as Gen's sheet prices it: the composer's own default engine, at the project's aspect, whole credits", () => {
  const rows: EngineRow[] = [
    { id: "gpt-image-2", kind: "image", resolutions: ["1024"], ratios: ["1:1", "16:9", "9:16"], durations: [], rate: { credits: 4, resolution: "1024", ratio: "9:16", duration: null } },
    { id: "dreamina-seedance-2-5-260628", kind: "video", resolutions: ["720p", "1080p"], ratios: ["16:9", "9:16"], durations: [5, 10], rate: { credits: 45, resolution: "720p", ratio: "9:16", duration: 5 } },
    { id: "soul-identity", kind: "image", resolutions: ["1024"], ratios: ["1:1"], durations: [], soulIdentity: true },
  ];
  const models = workspaceModels(rows, null);
  const image = activeModel({ ...INITIAL_COMPOSER, type: "image", billing: "workspace", chosen: {} }, models)!;
  expect(image.id).toBe("gpt-image-2");
  const at = { aspect: "9:16", picks: {}, references: [], seconds: 10, takes: 1 };
  const price = rowPrice(image, {}, at);
  expect(price).toMatchObject({ credits: 4, unit: "cr" });
  expect(alternativePrice(image.label, price)).toBe(`${image.label} · 4 cr · 1024 · 9:16`);
  const video = activeModel({ ...INITIAL_COMPOSER, type: "video", billing: "workspace", chosen: {} }, models)!;
  expect(alternativePrice(video.label, rowPrice(video, {}, at))).toBe(`${video.label} · 45 cr · 5 s · 720p · 9:16`);
  /* A rate read at other settings is not this price: nothing is shown rather than a guess. */
  expect(alternativePrice(image.label, rowPrice(image, {}, { ...at, aspect: "1:1" }))).toBeNull();
  expect(alternativePrice("Any", null)).toBeNull();
  expect(alternativePrice("Big", { credits: 1250, unit: "cr", detail: "" })).toBe("Big · 1,250 cr");
});

test("a cast entry's still is made from its prompt, else its description, else its name", () => {
  expect(castStillPrompt({ name: "Fox", description: "A red fox", prompt: "  A red fox on ice at dusk " })).toBe("A red fox on ice at dusk");
  expect(castStillPrompt({ name: "Fox", description: " A red fox ", prompt: "" })).toBe("A red fox");
  expect(castStillPrompt({ name: " Fox ", description: "", prompt: " " })).toBe("Fox");
  expect(castStillPrompt({ name: "", description: "", prompt: "" })).toBe("");
});

test("an Atomik plan that spends through the connected account is the owner's; plans on this workspace's credits are not", () => {
  expect(runsOnOwnerAccount(PLANS.motion)).toBe(true);
  expect(runsOnOwnerAccount(PLANS.swap)).toBe(true);
  expect(runsOnOwnerAccount(PLANS.marketing)).toBe(false);
  expect(runsOnOwnerAccount(PLANS.boards)).toBe(false);
  expect(runsOnOwnerAccount(null)).toBe(false);
});

test("the run engine refuses every member's connected plan before reading or pricing, while workspace plans remain available", async () => {
  let requests = 0;
  const plans = ownerAccountPlans(PLANS, false, "Workspace owner");
  const engine = new AtomikRunEngine({ plans, context: () => ({ projectId: "film", data: {}, fetch: async () => { requests++; throw new Error("A member must not reach the connected account."); } }) });
  for (const page of ["motion", "swap", "generate", "shorts"]) {
    expect(engine.start(page)).toEqual({ ok: false, reason: "Run by Workspace owner on the Higgsfield account" });
    expect(engine.getState().run).toBeNull();
    expect(await engine.approve()).toEqual({ ok: false, reason: "not-waiting" });
  }
  expect(requests).toBe(0);
  expect(plans.marketing).toBe(PLANS.marketing);
  expect(plans.boards).toBe(PLANS.boards);
  expect(ownerAccountPlans(PLANS, true, null)).toBe(PLANS);
});

test("the owner's failed read of the account is said as it is on Generate — never 'no account is connected'", () => {
  const base = {
    state: { ...INITIAL_COMPOSER, billing: "connected" as const, prompt: "a wave" }, model: null, quote: null, quoteKey: "k", submitting: false,
    catalogue: { loading: false, error: null },
  };
  expect(composerBlock({ ...base, capability: { owner: true, connected: false, suspended: false, unreadable: "The connected account is temporarily unavailable." } }))
    .toBe("The connected account is temporarily unavailable.");
  expect(composerBlock({ ...base, capability: { owner: true, connected: false, suspended: false, unreadable: null } }))
    .toBe("No account is connected. Connect one in Workspace › Engines, or use this workspace’s credits.");
  expect(composerBlock({ ...base, capability: null })).toBe("Reading the connected account…");
});

test("Business, Viral, Gen's composer and the connected workflows no longer read /api/me for ownership: the session decides, once", () => {
  for (const file of ["lib/shell/use-business.ts", "lib/shell/use-viral.ts", "lib/workspace/use-composer.ts", "components/graphite/tools/WorkflowHost.tsx"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toContain("/api/me");
    expect(source, file).toContain("useConnectedCapability");
  }
  /* The connection itself is read in one place for the shell's surfaces. */
  for (const file of ["lib/shell/use-business.ts", "lib/workspace/use-composer.ts"]) expect(readFileSync(file, "utf8"), file).not.toContain("/api/higgsfield/consumer/connection");
  /* Engines, where the account is connected and disconnected, busts the shared answer. */
  expect(readFileSync("components/graphite/ConnectedAccountRow.tsx", "utf8")).toContain("bustConnectedCapability(scope)");
});

/* ── Atomik › Tools & connections: the reach check rides the same capability ── */

/** The account's answer to a reach check: every capability row offered. */
const checkedReach = (): ReachState => ({ kind: "checked", checkedAt: 1, checks: CONNECTED_REACH.map((row) => ({ id: row.id, available: true })) });

test("Tools: a reach check that set out before a disconnect lands on nothing — not kept, not shared — and the check after it still answers", () => {
  let now = 1_000_000;
  const { store } = harness();
  const memory = createReachMemory(() => now);
  const scope = "owner-a";
  store.settle(scope, { connected: true });

  /* Tools asks the account while it is connected, and the page is left before the reply… */
  const left = memory.begin(scope, store.mark(scope));
  /* …the owner disconnects in Engines, which reads the new state and shares it. */
  store.bust(scope);
  store.settle(scope, { connected: false }, store.mark(scope));
  /* The late reply lands on nothing: back on the page, nothing of it is reused. */
  expect(memory.land(left, store.mark(scope), checkedReach())).toBe(false);
  expect(memory.recall(scope, store.mark(scope))).toBeNull();

  /* Tools stays open this time: it checks again under the new connection, and an older reply lands meanwhile. */
  const before = memory.begin(scope, store.mark(scope));
  store.bust(scope);
  store.settle(scope, { connected: false }, store.mark(scope));
  const after = memory.begin(scope, store.mark(scope));
  now += 1_000;
  expect(memory.land(before, store.mark(scope), checkedReach())).toBe(false);
  expect(memory.recall(scope, store.mark(scope))).toBeNull();
  /* What the page would share of it is refused too: the account stays disconnected on every surface. */
  expect(store.settle(scope, reachConnection(checkedReach())!, before.revision)).toBe(false);
  expect(store.get(scope)).toMatchObject({ status: "ready", connected: false });

  /* The check that set out after the disconnect is still the page's answer, and shares it. */
  const answer = reachStateFrom(409, { code: "not_connected" });
  expect(memory.land(after, store.mark(scope), answer)).toBe(true);
  expect(store.settle(scope, reachConnection(answer)!, after.revision)).toBe(true);
  expect(store.get(scope)).toMatchObject({ status: "ready", connected: false, reconnect: false });
  /* "Connect first" is not kept: once connected, the next visit asks again. */
  expect(memory.recall(scope, store.mark(scope))).toBeNull();
});

test("Tools: a newer check of the same workspace supersedes an older one still in flight; the older reply cannot overwrite it", () => {
  const memory = createReachMemory(() => 1_000_000);
  const first = memory.begin("s", 0);
  const second = memory.begin("s", 0);
  expect(memory.land(second, 0, checkedReach())).toBe(true);
  expect(memory.land(first, 0, reachStateFrom(503, { code: "unavailable" }))).toBe(false);
  expect(memory.recall("s", 0)).toMatchObject({ kind: "checked" });
  /* A reply lands once: the same check cannot land again later. */
  expect(memory.land(second, 0, reachStateFrom(409, { code: "not_connected" }))).toBe(false);
  expect(memory.recall("s", 0)).toMatchObject({ kind: "checked" });
  /* A newer answer of another kind drops what was kept: a checked answer does not outlive the account going away. */
  const third = memory.begin("s", 0);
  expect(memory.land(third, 0, reachStateFrom(409, { code: "reconnect_required" }))).toBe(true);
  expect(memory.recall("s", 0)).toBeNull();
});

test("Tools: each workspace keeps its own reach answer for a minute under its own connection — returning from another workspace never shows that one's", () => {
  let now = 1_000_000;
  const { store } = harness();
  const memory = createReachMemory(() => now);
  const a = memory.begin("studio-a", store.mark("studio-a"));
  /* A check of another workspace in flight does not make this one's reply stale. */
  const b = memory.begin("studio-b", store.mark("studio-b"));
  expect(memory.land(a, store.mark("studio-a"), checkedReach())).toBe(true);
  /* Another workspace (or another person in it) is another scope: nothing of A's answer is there. */
  expect(memory.recall("studio-b", store.mark("studio-b"))).toBeNull();
  expect(memory.land(b, store.mark("studio-b"), reachStateFrom(409, { code: "not_connected" }))).toBe(true);
  expect(memory.recall("studio-b", store.mark("studio-b"))).toBeNull();

  /* Back in A within the minute, A's own answer is reused rather than asked again. */
  now += REACH_REUSE_MS - 1;
  expect(memory.recall("studio-a", store.mark("studio-a"))).toMatchObject({ kind: "checked" });
  /* A disconnect in B leaves A's answer alone; one in A drops it. */
  store.bust("studio-b");
  expect(memory.recall("studio-a", store.mark("studio-a"))).toMatchObject({ kind: "checked" });
  store.bust("studio-a");
  expect(memory.recall("studio-a", store.mark("studio-a"))).toBeNull();
  /* After the minute an answer is checked again, even under an unchanged connection. */
  const again = memory.begin("studio-a", store.mark("studio-a"));
  expect(memory.land(again, store.mark("studio-a"), checkedReach())).toBe(true);
  now += REACH_REUSE_MS;
  expect(memory.recall("studio-a", store.mark("studio-a"))).toBeNull();
});

test("Tools: other surfaces' ordinary reads and settles never move the revision the reach answer is kept under; a connect, reconnect or disconnect does", async () => {
  const { store, pending, flush } = harness();
  const memory = createReachMemory(() => 1_000_000);
  const revision = store.mark("s");
  expect(memory.land(memory.begin("s", revision), store.mark("s"), checkedReach())).toBe(true);
  /* Viral's runs, Cast's jobs and the composer settle the connection as they poll; the store reads it again when stale. */
  for (let i = 0; i < 5; i++) expect(store.settle("s", { connected: true }, store.mark("s"))).toBe(true);
  const read = store.ensure("s", true);
  await flush();
  pending[0].resolve({ connected: true });
  await read;
  expect(store.mark("s")).toBe(revision);
  expect(memory.recall("s", store.mark("s"))).toMatchObject({ kind: "checked" });
  store.bust("s");
  expect(store.mark("s")).not.toBe(revision);
  expect(memory.recall("s", store.mark("s"))).toBeNull();
});

test("Tools: a reach reply shares only what it says of the connection, read as the connection route's own answer would be", () => {
  const checked = reachConnection(checkedReach());
  expect(checked).toEqual({ connected: true, requiresReconnect: false });
  expect(connectionFrom(checked)).toEqual({ connected: true, reconnect: false });
  const none = reachConnection(reachStateFrom(409, { code: "not_connected" }));
  expect(none).toEqual({ connected: false, requiresReconnect: false });
  expect(connectionFrom(none)).toEqual({ connected: false, reconnect: false });
  const lapsed = reachConnection(reachStateFrom(401, { code: "reconnect_required" }));
  expect(lapsed).toEqual({ connected: false, requiresReconnect: true });
  expect(connectionFrom(lapsed)).toEqual({ connected: false, reconnect: true });
  /* Owner only, too often, unavailable, or an answer that could not be read says nothing about the connection. */
  for (const [status, body] of [[403, { error: "Only the owner" }], [429, { code: "rate_limited" }], [503, { code: "unavailable" }], [200, { reach: "garbled" }]] as const)
    expect(reachConnection(reachStateFrom(status, body)), `${status}`).toBeNull();
  expect(reachConnection({ kind: "checking" })).toBeNull();
  expect(reachConnection({ kind: "owner-only" })).toBeNull();
});

test("Tools & connections takes owner, scope and revision from the shared capability, and reads no connection of its own", () => {
  const source = readFileSync("components/graphite/atomik/ToolsView.tsx", "utf8");
  expect(source).toContain("useConnectedCapability(undefined, { read: false })");
  expect(source).toContain("markConnectedCapability(scope)");
  expect(source).toContain("settleConnectedCapability(ticket.scope, connection, ticket.revision)");
  expect(source).not.toContain("/api/higgsfield/consumer/connection");
  expect(source).not.toMatch(/session\.(owner|requestScope)/);
});
