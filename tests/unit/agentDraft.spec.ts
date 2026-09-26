import { test, expect } from "@playwright/test";
import {
  AGENT_DRAFT_EVENT, agentDraftKey, holdAgentRequest, parseAgentDraft, prefillAgentRequest, shownAgentDraft, takeHeldAgentRequest, type AgentDraftEdit,
} from "../../lib/shell/agent-draft";

/*
 * ⌘K › "Ask Atomik: …" hands its words to the Agent box. Two ways they were
 * lost: an open box that had been typed in kept showing (then re-saving) the
 * old text, and a question asked before any project was open was dropped.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, String(value)); }
  removeItem(key: string) { this.map.delete(key); }
}
const events: string[] = [];
const g = globalThis as unknown as { localStorage: MemoryStorage; sessionStorage: MemoryStorage; window: { dispatchEvent: (e: Event) => boolean } };
test.beforeEach(() => {
  g.localStorage = new MemoryStorage();
  g.sessionStorage = new MemoryStorage();
  g.window = { dispatchEvent: (e: Event) => { events.push(e.type); return true; } };
  events.length = 0;
});
/* The shims leave with the test: other specs in this worker read `typeof window` to know they run on the server. */
test.afterEach(() => {
  const loose = globalThis as unknown as Record<string, unknown>;
  delete loose.localStorage; delete loose.sessionStorage; delete loose.window;
});

test("a ⌘K request replaces an earlier edit in an open box; the box's own edits still show while storage agrees", () => {
  const key = agentDraftKey("scope-a", "atomik", "p1");
  expect(key).toBe("aw_draft:suite-agent:scope-a:atomik:p1");
  /* The person typed "old words": stored and shown. */
  const typed = JSON.stringify({ request: "old words", refs: ["a1"] });
  const edit: AgentDraftEdit = { key, value: { request: "old words", refs: ["a1"] }, seen: [null, typed] };
  expect(shownAgentDraft(key, typed, edit)).toEqual({ request: "old words", refs: ["a1"] });
  /* Storage refused the write (private mode): the edit still shows. */
  expect(shownAgentDraft(key, null, edit).request).toBe("old words");

  /* ⌘K writes the new question into the same draft, keeping the references. */
  g.localStorage.setItem(key!, typed);
  expect(prefillAgentRequest("scope-a", "atomik", "p1", "  make a thirty second teaser  ")).toBe(true);
  expect(events).toEqual([AGENT_DRAFT_EVENT]);
  const stored = g.localStorage.getItem(key!);
  expect(parseAgentDraft(stored)).toEqual({ request: "make a thirty second teaser", refs: ["a1"] });
  /* The open box's old edit no longer answers for what storage holds: the question shows. */
  expect(shownAgentDraft(key, stored, edit)).toEqual({ request: "make a thirty second teaser", refs: ["a1"] });
  /* An edit for another project never shows here. */
  expect(shownAgentDraft(key, typed, { ...edit, key: agentDraftKey("scope-a", "atomik", "p2") }).request).toBe("old words");
  expect(shownAgentDraft(key, stored, { ...edit, key: agentDraftKey("scope-a", "atomik", "p2") }).request).toBe("make a thirty second teaser");
});

test("nothing is written without a scope or words; an unreadable draft reads empty", () => {
  expect(prefillAgentRequest(null, "atomik", "p1", "words")).toBe(false);
  expect(prefillAgentRequest("scope-a", "atomik", "p1", "   ")).toBe(false);
  expect(events).toEqual([]);
  expect(parseAgentDraft("{not json")).toEqual({ request: "", refs: [] });
  expect(parseAgentDraft(JSON.stringify({ request: "x", refs: [1, "b"] }))).toEqual({ request: "x", refs: ["b"] });
});

test("a question asked before any project is open waits in this tab, once, for its own scope", () => {
  expect(takeHeldAgentRequest("scope-a")).toBeNull();
  expect(holdAgentRequest("scope-a", "  a teaser for the launch ")).toBe(true);
  /* Another account or workspace in this tab never receives it. */
  expect(takeHeldAgentRequest("scope-b")).toBeNull();
  expect(takeHeldAgentRequest("scope-a")).toBe("a teaser for the launch");
  expect(takeHeldAgentRequest("scope-a")).toBeNull();
  expect(holdAgentRequest(null, "words")).toBe(false);
  expect(holdAgentRequest("scope-a", " ")).toBe(false);
});
