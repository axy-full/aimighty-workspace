import { test, expect } from "@playwright/test";
import { switchWorkspace, SWITCH_FAILED, UNSAVED_BEFORE_SWITCH } from "../../lib/shell/switch-workspace";

/**
 * The one workspace switch (lib/shell/switch-workspace.ts), TENANCY: every save carries the scope of the workspace it
 * was made in, so the board's pending save goes out BEFORE the switch route is asked, and the route is never asked
 * when that save failed. A refusal from the route leaves the page where it is; only an agreed switch leaves it.
 */
type Call = { url: string; init?: RequestInit };

function harness(answer: () => Promise<Response> | Response = () => Response.json({ ok: true, active: "ws-b" })) {
  const events: string[] = [];
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    events.push("switch");
    calls.push({ url, init });
    return answer();
  };
  const go = () => { events.push("go"); };
  return { events, calls, fetch, go };
}

/** A save the test releases by hand, with its outcome. */
function heldDrain(events: string[]) {
  let release: (saved: boolean) => void = () => {};
  const drain = () => {
    events.push("drain");
    return new Promise<boolean>((resolve) => { release = (saved) => { events.push(saved ? "saved" : "not saved"); resolve(saved); }; });
  };
  return { drain, release: (saved: boolean) => release(saved) };
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the pending save goes out first; the switch is asked only once it saved, then the page leaves", async () => {
  const h = harness();
  const held = heldDrain(h.events);
  const result = switchWorkspace({ id: "ws-b", fetch: h.fetch, go: h.go, drain: held.drain });
  await flushed();
  expect(h.events, "nothing is asked while the save is out").toEqual(["drain"]);
  held.release(true);
  expect(await result).toBeNull();
  expect(h.events).toEqual(["drain", "saved", "switch", "go"]);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].url).toBe("/api/workspaces/switch");
  expect(h.calls[0].init?.method).toBe("POST");
  expect(JSON.parse(String(h.calls[0].init?.body))).toEqual({ id: "ws-b" });
});

test("a save that failed: no switch is asked, the page stays, and it says so plainly", async () => {
  const h = harness();
  const held = heldDrain(h.events);
  const result = switchWorkspace({ id: "ws-b", fetch: h.fetch, go: h.go, drain: held.drain });
  await flushed();
  held.release(false);
  expect(await result).toBe(UNSAVED_BEFORE_SWITCH);
  expect(UNSAVED_BEFORE_SWITCH).toBe("Your last edit could not be saved. Try again before switching.");
  expect(h.events).toEqual(["drain", "not saved"]);
});

test("a save that threw counts as not saved: no switch is asked", async () => {
  const h = harness();
  const result = await switchWorkspace({ id: "ws-b", fetch: h.fetch, go: h.go, drain: () => Promise.reject(new Error("offline")) });
  expect(result).toBe(UNSAVED_BEFORE_SWITCH);
  expect(h.events).toEqual([]);
});

test("a refused switch: the route's own sentence, and the page stays", async () => {
  const h = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  const result = await switchWorkspace({ id: "ws-x", fetch: h.fetch, go: h.go, drain: async () => true });
  expect(result).toBe("Not a workspace of yours.");
  expect(h.events).toEqual(["switch"]);
});

test("a refusal with no sentence of its own, or none readable, says the caller's fallback", async () => {
  const blank = harness(() => new Response("upstream down", { status: 503 }));
  expect(await switchWorkspace({ id: "ws-b", fetch: blank.fetch, go: blank.go })).toBe(SWITCH_FAILED);
  const named = harness(() => Response.json({}, { status: 500 }));
  expect(await switchWorkspace({ id: "ws-b", fetch: named.fetch, go: named.go, fallback: "The workspace could not be switched. Try again." }))
    .toBe("The workspace could not be switched. Try again.");
  expect([...blank.events, ...named.events]).not.toContain("go");
});

test("a dropped connection: its message, and the page stays", async () => {
  const h = harness(() => Promise.reject(new TypeError("Failed to fetch")));
  expect(await switchWorkspace({ id: "ws-b", fetch: h.fetch, go: h.go })).toBe("Failed to fetch");
  expect(h.events).toEqual(["switch"]);
});

test("where nothing is ever pending (no board), the switch is asked at once", async () => {
  const h = harness();
  expect(await switchWorkspace({ id: "ws-b", fetch: h.fetch, go: h.go, drain: null })).toBeNull();
  expect(h.events).toEqual(["switch", "go"]);
});

test("a second press while one runs starts nothing of its own and gets the same answer", async () => {
  const h = harness();
  const held = heldDrain(h.events);
  const first = switchWorkspace({ id: "ws-b", fetch: h.fetch, go: h.go, drain: held.drain });
  const second = switchWorkspace({ id: "ws-c", fetch: h.fetch, go: h.go, drain: held.drain });
  await flushed();
  held.release(true);
  expect(await first).toBeNull();
  expect(await second).toBeNull();
  expect(h.events).toEqual(["drain", "saved", "switch", "go"]);
  expect(JSON.parse(String(h.calls[0].init?.body))).toEqual({ id: "ws-b" });
  /* Once it has ended, a new press is its own switch again. */
  const again = harness(() => Response.json({ error: "Not a workspace of yours." }, { status: 403 }));
  expect(await switchWorkspace({ id: "ws-c", fetch: again.fetch, go: again.go })).toBe("Not a workspace of yours.");
  expect(again.events).toEqual(["switch"]);
});
