import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  ACCOUNT_RETIRED, ALTERNATIVE_LABEL, CAPABILITY_FRESH_MS, CAPABILITY_UNREADABLE, CONNECTED_PROVIDER, HISTORY_KEPT, OWNER_RUNS, OWNER_RUN_LEGACY_SUITES, OWNER_RUN_PAGES, OWNER_RUN_SUITES,
  alternativePrice, capabilityOf, castStillPrompt, connectionFrom, createCapabilityStore, isOwnerRunPage, isOwnerRunSuite,
  ownerRunEyebrow, runsOnOwnerAccount, ownerAccountPlans, type ConnectionReply,
} from "../../lib/shell/connected-capability";
import { SIGN_IN_RETIRED, SIGN_IN_RETIRED_MESSAGE } from "../../lib/higgsfield-consumer/retired";
import { OWN_PAGES } from "../../lib/shell/business-own";
import { SHELL_SUITES } from "../../lib/shell/ia";
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

test("the words everyone meets since the sign-in was retired: what ran on the account, that Particl no longer signs in, no owner name, and the workspace-credit way", () => {
  expect(CONNECTED_PROVIDER).toBe("Higgsfield");
  expect(ACCOUNT_RETIRED).toBe("Particl no longer signs in to Higgsfield");
  expect(HISTORY_KEPT).toBe("Past results stay in your Library.");
  /* The card and the routes say the same thing. */
  expect(`${ACCOUNT_RETIRED}. ${HISTORY_KEPT}`).toBe(SIGN_IN_RETIRED_MESSAGE);
  expect(OWNER_RUNS.business.alternative).toMatchObject({ type: "image", action: "Open Gen · Images" });
  /* Viral runs on Particl's API key for everyone now: it has no retired card. Business's card is Ads' and Setup's. */
  expect(Object.keys(OWNER_RUNS)).not.toContain("viral");
  expect(OWNER_RUNS.business.line).toBe("Ads here ran on a signed-in Higgsfield account.");
  expect(OWNER_RUNS.cast.alternative).toMatchObject({ type: "image", action: "Open Gen · Images" });
  expect(OWNER_RUNS.cast.alternative?.what).toContain("Studio image engines");
  /* Dubbing, voice change and social cuts have no Studio engine that makes the same thing: no alternative is invented. */
  expect(OWNER_RUNS.workflows.alternative).toBeNull();
  expect(ownerRunEyebrow("workflows", ["Dub", "Change voice"])).toBe("Dub · Change voice");
  expect(ownerRunEyebrow("business")).toBe(OWNER_RUNS.business.eyebrow);
  expect(ALTERNATIVE_LABEL).toBe("On this workspace’s credits");
  for (const run of Object.values(OWNER_RUNS)) {
    /* One short line each, in the past tense, never a connect prompt, never who runs it, never the account's credits. */
    expect(run.line.split(". ").length).toBe(1);
    expect(run.line).toMatch(/ ran on a signed-in Higgsfield account\.$/);
    for (const words of [run.line, run.eyebrow, run.alternative?.what ?? ""]) expect(words).not.toMatch(/\bConnect (it|the|one)\b|Engines ›|Workspace ›|connected cr|Higgsfield credits|\bbalance\b|\brun by\b|\bowner\b/i);
  }
  /* No suite ran on the account as a whole any more: Viral and Business › Image ads run on Particl's API key for everyone,
     Business's own tools are everyone's, and the Business pages that ran on the account (Ads, Setup) are the retired card page by page. */
  expect(OWNER_RUN_SUITES).toEqual([]);
  expect(isOwnerRunSuite("business") || isOwnerRunSuite("viral") || isOwnerRunSuite("studio") || isOwnerRunSuite("gen") || isOwnerRunSuite("atomik") || isOwnerRunSuite(null)).toBe(false);
  expect(OWNER_RUN_PAGES).toEqual({ business: ["ads", "setup"] });
  for (const page of ["ads", "setup"]) expect(isOwnerRunPage("business", page), page).toBe(true);
  for (const page of ["dtc", ...OWN_PAGES]) expect(isOwnerRunPage("business", page), page).toBe(false);
  for (const page of ["motion", "swap", "history"]) expect(isOwnerRunPage("viral", page), page).toBe(false);
  expect(isOwnerRunPage("studio", "cast") || isOwnerRunPage("business", null) || isOwnerRunPage(null, "ads")).toBe(false);
  /* Every owner-run page names a page the suite really has. */
  for (const [suite, pages] of Object.entries(OWNER_RUN_PAGES)) for (const page of pages) expect(SHELL_SUITES.find((s) => s.id === suite)?.pages.some((p) => p.id === page), `${suite}/${page}`).toBe(true);
  /* The state layer's suites behind a whole suite that ran on the account: none (Business's Image ads and its own tools are everyone's). */
  expect(SHELL_SUITES.filter((suite) => OWNER_RUN_SUITES.includes(suite.id)).map((suite) => suite.legacy).sort()).toEqual([...OWNER_RUN_LEGACY_SUITES].sort());
  expect(OWNER_RUN_LEGACY_SUITES).toEqual([]);
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

test("no Atomik plan runs on the connected account's routes any more: Compare reads the project's Library, for every member", () => {
  /* Compare and History read Particl's own Library of takes; Motion Transfer and Object Swap run on the API-key engines; Generate and Shorts are not runnable. */
  for (const [page, plan] of Object.entries(PLANS)) expect(runsOnOwnerAccount(plan), page).toBe(false);
  expect(runsOnOwnerAccount(null)).toBe(false);
  /* The rule still catches anything that would call an account route. */
  expect(runsOnOwnerAccount({ steps: [{ executor: { backend: { path: "/api/higgsfield/consumer/genjutsu" } } }] })).toBe(true);
});

test("the run engine refuses a plan on the account's routes before reading or pricing, saying the sign-in is retired; every registry plan, Compare included, is the same for everyone", async () => {
  let requests = 0;
  const [load] = PLANS.compare.steps;
  /* Compare as it was before it read the Library: its read on the owner-only account route. */
  const onAccount = { ...PLANS.compare, steps: [{ ...load, executor: { type: "call" as const, backend: { method: "GET" as const, path: "/api/higgsfield/consumer/genjutsu" }, run: async () => { requests++; return {}; } } }] };
  const plans = ownerAccountPlans({ ...PLANS, compare: onAccount }, false);
  const engine = new AtomikRunEngine({ plans, context: () => ({ projectId: "film", data: {}, fetch: async () => { requests++; throw new Error("Nothing may reach the connected account."); } }) });
  expect(engine.start("compare")).toEqual({ ok: false, reason: "Particl no longer signs in to Higgsfield." });
  expect(engine.getState().run).toBeNull();
  expect(await engine.approve()).toEqual({ ok: false, reason: "not-waiting" });
  expect(requests).toBe(0);
  /* The registry's own plans touch no account route, so every workspace gets them as they are. */
  const everyone = ownerAccountPlans(PLANS, false);
  for (const page of Object.keys(PLANS) as (keyof typeof PLANS)[]) expect(everyone[page], page).toBe(PLANS[page]);
  expect(ownerAccountPlans(PLANS, true)).toBe(PLANS);
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

test("Business, Gen's composer and the connected workflows no longer read /api/me for ownership: the session decides, once", () => {
  for (const file of ["lib/shell/use-business.ts", "lib/workspace/use-composer.ts", "components/graphite/tools/WorkflowHost.tsx"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toContain("/api/me");
    expect(source, file).toContain("useConnectedCapability");
  }
  /* The connection itself is read in one place for the shell's surfaces. */
  for (const file of ["lib/shell/use-business.ts", "lib/workspace/use-composer.ts"]) expect(readFileSync(file, "utf8"), file).not.toContain("/api/higgsfield/consumer/connection");
  /* Engines is the one place that still reads the owner's connection: to list running jobs and to Disconnect. It never starts a sign-in. */
  const row = readFileSync("components/graphite/ConnectedAccountRow.tsx", "utf8");
  expect(row).toContain("CONNECTION_ENDPOINT");
  expect(row).toContain('method: "DELETE"');
  expect(row).not.toMatch(/consumer\/connect"|consumerAuthorizeUrl|"Reconnect|Opening sign-in|window\.location\.assign/);
  /* Viral and Business › Image ads read nothing of the connected account at all: they run on Particl's API key. */
  for (const file of ["components/graphite/viral/ViralView.tsx", "lib/shell/viral.ts", "lib/shell/use-key-take.ts", "lib/shell/image-ads.ts", "lib/shell/use-marketing-presets.ts", "components/graphite/business/PresetPicker.tsx"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/\/api\/higgsfield\/consumer\/|higgsfield-consumer\/|useConnectedCapability|use-business/);
  }
});

test("retired with the Higgsfield sign-in: the capability answers member for everyone, the owner included, so no surface reads the account", () => {
  expect(SIGN_IN_RETIRED).toBe(true);
  const hook = readFileSync("lib/shell/use-connected-capability.ts", "utf8");
  expect(hook).toContain("const owner = !SIGN_IN_RETIRED && session.signedIn && session.owner === true;");
  /* With owner false the store is never asked, whatever it holds. */
  expect(capabilityOf(false, { status: "ready", connected: true, reconnect: false, error: null, at: 1 }, "Harbour Owner")).toMatchObject({ owner: false, status: "member", connected: false });
  /* The shell's collector still finishes jobs already running: it keys on the session, not on this hook. */
  expect(readFileSync("lib/shell/state.tsx", "utf8")).toContain("owner: session.owner");
});

/* ── Atomik › Tools & connections reaches no signed-in account ── */

test("Tools & connections checks no connected account: it reads no capability, reach or connection route", () => {
  const source = readFileSync("components/graphite/atomik/ToolsView.tsx", "utf8");
  expect(source).not.toContain("useConnectedCapability");
  expect(source).not.toContain("/api/higgsfield/consumer/");
  expect(source).not.toMatch(/session\.(owner|requestScope)/);
});
