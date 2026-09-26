import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  CAPABILITY_FRESH_MS, CAPABILITY_UNREADABLE, OWNER_RUNS, OWNER_RUN_SUITES, capabilityOf, castStillPrompt, connectionFrom,
  createCapabilityStore, isOwnerRunSuite, ownerBadgeNote, ownerRunBy, ownerRunTitle, runsOnOwnerAccount, type ConnectionReply,
} from "../../lib/shell/connected-capability";
import { PLANS } from "../../lib/workspace/plans";

/**
 * Idea 19 — who runs the connected account, read once per scope and shared.
 * The owner alone connects and spends through it (every
 * /api/higgsfield/consumer route is owner-only), so a member's surfaces are
 * decided from the session and read nothing; the owner's connection is one
 * read per scope, deduplicated, reused while fresh, re-read behind the answer
 * on screen, and a failed read is an error to retry — never a demotion to
 * member.
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

test("a stale answer stays on screen while it is read again; a failed re-read keeps it", async () => {
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
  expect(store.get("s")).toMatchObject({ status: "ready", connected: true, error: null });
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

  /* Forced, a fresh answer is read again too (the owner reconnected elsewhere). */
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

test("a member's words: who runs it by name, the workspace-credit way to make the same kind of thing, and where Gen opens", () => {
  expect(ownerRunBy("Harbour Owner")).toBe("Harbour Owner");
  expect(ownerRunBy("   ")).toBe("the workspace owner");
  expect(ownerRunBy(null)).toBe("the workspace owner");
  expect(ownerRunTitle("business", "Harbour Owner")).toBe("Business is run by Harbour Owner");
  expect(ownerRunTitle("viral", null)).toBe("Viral is run by the workspace owner");
  expect(ownerRunTitle("cast", "Harbour Owner")).toBe("Soul Cinema and Soul ID are run by Harbour Owner");
  expect(ownerBadgeNote("Harbour Owner")).toBe("Run by Harbour Owner on the Higgsfield account");
  expect(OWNER_RUNS.business).toMatchObject({ type: "image", action: "Open Gen · Images" });
  expect(OWNER_RUNS.viral).toMatchObject({ type: "video", action: "Open Gen · Video" });
  expect(OWNER_RUNS.cast).toMatchObject({ type: "image", action: "Open Gen · Images" });
  /* The alternative is always this workspace's credits on Studio engines; one sentence, no connect prompt. */
  for (const run of Object.values(OWNER_RUNS)) {
    expect(run.line).toMatch(/Studio (image )?engines, on this workspace’s credits/);
    expect(run.line).not.toMatch(/Connect|Engines ›|Workspace ›/);
    expect(run.line.split(". ").length).toBe(1);
  }
  expect(OWNER_RUN_SUITES).toEqual(["business", "viral"]);
  expect(isOwnerRunSuite("business") && isOwnerRunSuite("viral")).toBe(true);
  expect(isOwnerRunSuite("studio") || isOwnerRunSuite("gen") || isOwnerRunSuite("atomik") || isOwnerRunSuite(null)).toBe(false);
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

test("Business, Viral and the connected workflows no longer read /api/me for ownership: the session decides, once", () => {
  for (const file of ["lib/shell/use-business.ts", "lib/shell/use-viral.ts", "components/graphite/tools/WorkflowHost.tsx"]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toContain("/api/me");
    expect(source, file).toContain("useConnectedCapability");
  }
  /* The connection itself is read in one place for the shell's surfaces. */
  expect(readFileSync("lib/shell/use-business.ts", "utf8")).not.toContain("/api/higgsfield/consumer/connection");
});
