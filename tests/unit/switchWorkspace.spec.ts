import { test, expect } from "@playwright/test";
import {
  createHeldEdits, editsFrozen, registerDrain, resetSwitchForTests, sendsAllowed, subscribeSwitch, switchState, switchWorkspace, whileSwitching,
  SWITCH_FAILED, SWITCH_TOO_LONG, SWITCHING, UNSAVED_AGAIN, UNSAVED_BEFORE_SWITCH, type Drain, type SwitchPhase,
} from "../../lib/shell/switch-workspace";

/**
 * The one workspace switch (lib/shell/switch-workspace.ts), TENANCY: every save carries the scope of the workspace it
 * was made in, so the board's pending save goes out BEFORE the switch route is asked (and once more just before), the
 * route is never asked when that save failed, the board takes no edits and sends nothing once the route is asked, and
 * only an agreed switch leaves the page. A switch that does not happen unfreezes everything.
 */
type Call = { url: string; init?: RequestInit };

test.beforeEach(() => resetSwitchForTests());

function harness(answer: (init?: RequestInit) => Promise<Response> | Response = () => Response.json({ ok: true, active: "ws-b" })) {
  const events: string[] = [];
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    events.push(`switch(${switchState().phase})`);
    calls.push({ url, init });
    return answer(init);
  };
  const go = () => { events.push(`go(${switchState().phase})`); };
  return { events, calls, fetch, go };
}

/** A drain whose first save the test releases by hand; the next ones answer at once with `later`. */
function heldDrain(events: string[], later = true) {
  let release: (saved: boolean) => void = () => {};
  let calls = 0;
  const drain = () => {
    calls++;
    events.push(`drain(${switchState().phase}, frozen=${editsFrozen()}, sends=${sendsAllowed()})`);
    if (calls > 1) return Promise.resolve(later);
    return new Promise<boolean>((resolve) => { release = (saved) => { events.push(saved ? "saved" : "not saved"); resolve(saved); }; });
  };
  return { drain, release: (saved: boolean) => release(saved) };
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A switch with `drain` registered as the only editor (null: no editor registered at all, a page with no board). */
function withDrain(drain: Drain | null, request: Parameters<typeof switchWorkspace>[0]) {
  const off = drain ? registerDrain(drain) : () => {};
  return switchWorkspace(request).finally(off);
}

test("the pending save goes out first, then once more; the switch is asked only once it saved, then the page leaves", async () => {
  const h = harness();
  const held = heldDrain(h.events);
  const result = withDrain(held.drain, { id: "ws-b", fetch: h.fetch, go: h.go });
  await flushed();
  expect(h.events, "nothing is asked while the save is out").toEqual(["drain(draining, frozen=true, sends=true)"]);
  held.release(true);
  expect(await result).toBeNull();
  expect(h.events).toEqual([
    "drain(draining, frozen=true, sends=true)", "saved",
    "drain(draining, frozen=true, sends=true)",
    "switch(posting)", "go(leaving)",
  ]);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].url).toBe("/api/workspaces/switch");
  expect(h.calls[0].init?.method).toBe("POST");
  expect(JSON.parse(String(h.calls[0].init?.body))).toEqual({ id: "ws-b" });
  /* Agreed: the page is leaving, edits stay frozen and nothing more is sent to the workspace being left. */
  expect(switchState()).toEqual({ phase: "leaving", id: "ws-b" });
  expect(editsFrozen()).toBe(true);
  expect(sendsAllowed()).toBe(false);
  const again = harness();
  expect(await switchWorkspace({ id: "ws-c", fetch: again.fetch, go: again.go })).toBeNull();
  expect(again.events, "a press while the page leaves does nothing").toEqual([]);
});

test("the phases in order, for whoever watches (the veil, the board, every switch control)", async () => {
  const seen: SwitchPhase[] = [];
  const stop = subscribeSwitch(() => seen.push(switchState().phase));
  const h = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  await withDrain(async () => true, { id: "ws-b", fetch: h.fetch, go: h.go });
  stop();
  expect(seen).toEqual(["draining", "posting", "idle"]);
  expect(editsFrozen()).toBe(false);
  expect(sendsAllowed()).toBe(true);
});

test("a save that failed: no switch is asked, the page stays and unfreezes, and it says so plainly; failing again, it says what to do", async () => {
  const h = harness();
  const held = heldDrain(h.events);
  const result = withDrain(held.drain, { id: "ws-b", fetch: h.fetch, go: h.go });
  await flushed();
  held.release(false);
  expect(await result).toBe(UNSAVED_BEFORE_SWITCH);
  expect(UNSAVED_BEFORE_SWITCH).toBe("Your last edit could not be saved. Try again before switching.");
  expect(h.events).toEqual(["drain(draining, frozen=true, sends=true)", "not saved"]);
  expect(switchState().phase).toBe("idle");
  expect(editsFrozen()).toBe(false);

  expect(await withDrain(async () => false, { id: "ws-b", fetch: h.fetch, go: h.go })).toBe(UNSAVED_AGAIN);
  expect(UNSAVED_AGAIN).toBe("Your last edit could not be saved. Copy it somewhere safe, then reload.");
  /* Once a save goes through, the count starts again. */
  const ok = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  await withDrain(async () => true, { id: "ws-b", fetch: ok.fetch, go: ok.go });
  expect(await withDrain(async () => false, { id: "ws-b", fetch: h.fetch, go: h.go })).toBe(UNSAVED_BEFORE_SWITCH);
  expect(h.events.filter((e) => e.startsWith("switch"))).toEqual([]);
});

test("the second save, just before the route, failing: no switch is asked", async () => {
  const h = harness();
  const held = heldDrain(h.events, false);
  const result = withDrain(held.drain, { id: "ws-b", fetch: h.fetch, go: h.go });
  await flushed();
  held.release(true);
  expect(await result).toBe(UNSAVED_BEFORE_SWITCH);
  expect(h.events.filter((e) => e.startsWith("switch") || e.startsWith("go"))).toEqual([]);
});

test("a save that threw counts as not saved: no switch is asked", async () => {
  const h = harness();
  const result = await withDrain(() => Promise.reject(new Error("offline")), { id: "ws-b", fetch: h.fetch, go: h.go });
  expect(result).toBe(UNSAVED_BEFORE_SWITCH);
  expect(h.events).toEqual([]);
});

test("a refused switch: the route's own sentence, and the page stays, unfrozen", async () => {
  const h = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  const result = await withDrain(async () => true, { id: "ws-x", fetch: h.fetch, go: h.go });
  expect(result).toBe("Not a workspace of yours.");
  expect(h.events).toEqual(["switch(posting)"]);
  expect(switchState()).toEqual({ phase: "idle", id: null });
});

test("a refusal with no sentence of its own, or none readable, says the caller's fallback", async () => {
  const blank = harness(() => new Response("upstream down", { status: 503 }));
  expect(await switchWorkspace({ id: "ws-b", fetch: blank.fetch, go: blank.go })).toBe(SWITCH_FAILED);
  const named = harness(() => Response.json({}, { status: 500 }));
  expect(await switchWorkspace({ id: "ws-b", fetch: named.fetch, go: named.go, fallback: "The workspace could not be switched. Try again." }))
    .toBe("The workspace could not be switched. Try again.");
  expect([...blank.events, ...named.events].some((e) => e.startsWith("go"))).toBe(false);
});

test("a dropped connection: its message, and the page stays", async () => {
  const h = harness(() => Promise.reject(new TypeError("Failed to fetch")));
  expect(await switchWorkspace({ id: "ws-b", fetch: h.fetch, go: h.go })).toBe("Failed to fetch");
  expect(h.events).toEqual(["switch(posting)"]);
  expect(switchState().phase).toBe("idle");
});

test("where nothing is ever pending (no board), the switch is asked at once", async () => {
  const h = harness();
  expect(await withDrain(null, { id: "ws-b", fetch: h.fetch, go: h.go })).toBeNull();
  expect(h.events).toEqual(["switch(posting)", "go(leaving)"]);
});

test("too long while saving: it says so, unfreezes, and the route is never asked, even when the save lands later", async () => {
  const h = harness();
  const held = heldDrain(h.events);
  const result = await withDrain(held.drain, { id: "ws-b", fetch: h.fetch, go: h.go, timeoutMs: 30 });
  expect(result).toBe(SWITCH_TOO_LONG);
  expect(switchState().phase).toBe("idle");
  held.release(true);
  await flushed();
  await flushed();
  expect(h.events.filter((e) => e.startsWith("switch") || e.startsWith("go"))).toEqual([]);
  expect(switchState().phase).toBe("idle");
});

test("too long while the route answers: the request is cancelled, it says so, and the page stays", async () => {
  let aborted = false;
  const h = harness((init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
  }));
  const asked: string[] = [];
  const result = await withDrain(async () => true, { id: "ws-b", fetch: h.fetch, go: h.go, timeoutMs: 30, whoami: async () => { asked.push(switchState().phase); return "ws-a"; } });
  expect(result).toBe(SWITCH_TOO_LONG);
  expect(aborted).toBe(true);
  expect(asked, "who this session is now was asked, still frozen").toEqual(["posting"]);
  await flushed();
  expect(h.events).toEqual(["switch(posting)"]);
  expect(switchState().phase).toBe("idle");
});

test("a second press while one runs starts nothing of its own and gets the same answer", async () => {
  const h = harness();
  const held = heldDrain(h.events);
  const first = withDrain(held.drain, { id: "ws-b", fetch: h.fetch, go: h.go });
  const second = withDrain(held.drain, { id: "ws-c", fetch: h.fetch, go: h.go });
  await flushed();
  held.release(true);
  expect(await first).toBeNull();
  expect(await second).toBeNull();
  expect(h.events.filter((e) => e.startsWith("switch"))).toHaveLength(1);
  expect(JSON.parse(String(h.calls[0].init?.body))).toEqual({ id: "ws-b" });
});

test("once a refused switch has ended, a new press is its own switch again", async () => {
  const refused = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  expect(await switchWorkspace({ id: "ws-c", fetch: refused.fetch, go: refused.go })).toBe("Not a workspace of yours.");
  const ok = harness();
  expect(await switchWorkspace({ id: "ws-c", fetch: ok.fetch, go: ok.go })).toBeNull();
  expect([...refused.events, ...ok.events]).toEqual(["switch(posting)", "switch(posting)", "go(leaving)"]);
});

test("too long while the route answers, but the switch landed all the same: the page leaves", async () => {
  const h = harness(() => new Promise<Response>(() => {}));
  const result = await withDrain(async () => true, { id: "ws-b", fetch: h.fetch, go: h.go, timeoutMs: 30, whoami: async () => "ws-b" });
  expect(result).toBeNull();
  expect(h.events).toEqual(["switch(posting)", "go(leaving)"]);
  expect(switchState().phase).toBe("leaving");
});

test("every registered editor is drained, in turn, twice, before the route; one that left is not; one that fails stops it", async () => {
  const events: string[] = [];
  const board = registerDrain(async () => { events.push("board"); return true; });
  const store = registerDrain(async () => { events.push("store"); return true; });
  const gone = registerDrain(async () => { events.push("gone"); return true; });
  gone();
  const h = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  await switchWorkspace({ id: "ws-b", fetch: async (url, init) => { events.push("switch"); return h.fetch(url, init); }, go: h.go });
  expect(events).toEqual(["board", "store", "board", "store", "switch"]);
  events.length = 0;
  const failing = registerDrain(async () => { events.push("edit & sound"); return false; });
  expect(await switchWorkspace({ id: "ws-b", fetch: async () => { events.push("switch"); return Response.json({ ok: true }); }, go: h.go })).toBe(UNSAVED_BEFORE_SWITCH);
  expect(events).toEqual(["board", "store", "edit & sound"]);
  board(); store(); failing();
});

test("an editing call while a switch runs is refused with \"Switching…\", in every phase but idle", async () => {
  expect(whileSwitching()).toBeNull();
  const seen: (string | null)[] = [];
  const stop = subscribeSwitch(() => seen.push(`${switchState().phase}:${whileSwitching()}`));
  const h = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  await withDrain(async () => true, { id: "ws-b", fetch: h.fetch, go: h.go });
  stop();
  expect(seen).toEqual([`draining:${SWITCHING}`, `posting:${SWITCHING}`, "idle:null"]);
  expect(SWITCHING).toBe("Switching…");
});

test("held edits replay as updaters onto the draft as it is then, never as a project computed before (stale replay)", () => {
  type Draft = { nodes: string[]; title: string };
  const held = createHeldEdits<(d: Draft) => Draft>();
  let draft: Draft = { nodes: ["shot-1"], title: "Before" };
  /* While the switch ran: the app retitled the draft, held. */
  held.hold((d) => ({ ...d, title: "Filed take" }));
  /* Meanwhile the drain's save merged in another window's new shot. */
  draft = { ...draft, nodes: [...draft.nodes, "shot-from-another-window"] };
  /* The switch did not happen: the held edit runs now, on the draft as it is. */
  expect(held.size).toBe(1);
  for (const edit of held.release()) draft = edit(draft);
  expect(draft).toEqual({ nodes: ["shot-1", "shot-from-another-window"], title: "Filed take" });
  expect(held.size).toBe(0);
});
