import { test, expect } from "@playwright/test";
import { PEOPLE_ONLY_POST, PostRefusal, actionsOf, agoWords, approve, isPerson, prepare, retry, sendForApproval, settle, stateLine, unschedule, whenWords, type Actor, type SocialPost } from "../../lib/social/posts";

/*
 * Gap screens, lane 3 · Social post states. The five states and what moves a post between them; above all that approving a post
 * is people-only: Atomik (an agent identity), an MCP client and every token prepare a post and can never approve, unschedule or
 * retry one; only a signed-in person can. Nothing here posts anything.
 */
const person: Actor = { kind: "person", userId: "user_1" };
const agent: Actor = { kind: "agent", runId: "rar_000000000000000000000009" };
const token: Actor = { kind: "token", tokenId: "tok_1" };
const at = Date.UTC(2026, 9, 9, 10, 0);
const draft = () => prepare({ id: "p1", platform: "tiktok", format: "clip", clip: "Clip 1 · 0:14", aspect: "9:16" });
const waiting = () => sendForApproval(draft());

test("a post is prepared as a draft, by anyone, and sent for approval", () => {
  const d = draft();
  expect(d).toMatchObject({ state: "draft", approvedBy: null, at: null, failure: null });
  expect(sendForApproval(d).state).toBe("waiting");
  expect(() => sendForApproval(waiting())).toThrow(PostRefusal);
});

test("approving is people-only: an agent, a token and a missing caller are refused, a person is not", () => {
  for (const who of [agent, token, null, undefined, { kind: "person", userId: "agent:rar_1" } as Actor, { kind: "person", userId: "server" } as Actor, { kind: "person", userId: "" } as Actor]) {
    expect(() => approve(waiting(), who, at)).toThrow(PEOPLE_ONLY_POST);
  }
  const done = approve(waiting(), person, at);
  expect(done).toMatchObject({ state: "scheduled", at, approvedBy: "user_1" });
  expect(isPerson(person)).toBe(true);
  expect(isPerson(agent)).toBe(false);
  expect(isPerson(token)).toBe(false);
});

test("a refusal for a non-person carries 403 and leaves the post as it was", () => {
  const w = waiting();
  try { approve(w, agent, at); throw new Error("approved"); } catch (cause) { expect((cause as PostRefusal).status).toBe(403); }
  expect(w.state).toBe("waiting");
  expect(w.approvedBy).toBeNull();
});

test("only a waiting post can be approved, and it needs a time", () => {
  expect(() => approve(draft(), person, at)).toThrow(/is draft/);
  expect(() => approve(waiting(), person, NaN)).toThrow(/Pick when/);
  const posted = settle(approve(waiting(), person, at), { ok: true, at });
  expect(() => approve(posted, person, at)).toThrow(/is posted/);
});

test("unscheduling is people-only and takes the approval with it", () => {
  const s = approve(waiting(), person, at);
  for (const who of [agent, token, null]) expect(() => unschedule(s, who)).toThrow(PEOPLE_ONLY_POST);
  expect(unschedule(s, person)).toMatchObject({ state: "draft", at: null, approvedBy: null });
  expect(() => unschedule(draft(), person)).toThrow(/is draft/);
});

test("the publisher's outcome settles a scheduled post as posted or failed, and only a scheduled one", () => {
  const s = approve(waiting(), person, at);
  expect(settle(s, { ok: true, at: at + 5 })).toMatchObject({ state: "posted", at: at + 5 });
  expect(settle(s, { ok: false, reason: "the account needs reconnecting", reconnect: true })).toMatchObject({ state: "failed", failure: { reconnect: true } });
  expect(() => settle(waiting(), { ok: true, at })).toThrow(PostRefusal);
});

test("Retry is free, a person's press, on the post that was approved; an account that needs reconnecting is reconnected first", () => {
  const failed = settle(approve(waiting(), person, at), { ok: false, reason: "the platform said no", reconnect: false });
  for (const who of [agent, token, null]) expect(() => retry(failed, who, at + 1)).toThrow(PEOPLE_ONLY_POST);
  expect(retry(failed, person, at + 1)).toMatchObject({ state: "scheduled", at: at + 1, failure: null, approvedBy: "user_1" });
  const needs = settle(approve(waiting(), person, at), { ok: false, reason: "the account needs reconnecting", reconnect: true });
  expect(() => retry(needs, person, at + 1)).toThrow(/Reconnect/);
  const unapproved: SocialPost = { ...failed, approvedBy: null };
  expect(() => retry(unapproved, person, at + 1)).toThrow(/never approved/);
});

test("what a card says in each state, and the free actions it offers", () => {
  const now = at + 2 * 3_600_000;
  const s = approve(waiting(), person, at);
  expect(stateLine(draft(), now)).toBe("Draft");
  expect(stateLine(waiting(), now)).toBe("Waiting for your approval");
  expect(stateLine(s, now)).toBe(`Scheduled · ${whenWords(at)}`);
  expect(stateLine(settle(s, { ok: true, at }), now)).toBe("Posted · 2 h ago");
  const failed = settle(s, { ok: false, reason: "the account needs reconnecting", reconnect: true });
  expect(stateLine(failed, now)).toBe("Failed · the account needs reconnecting · nothing posted");
  expect(actionsOf(draft())).toEqual(["send"]);
  expect(actionsOf(waiting())).toEqual(["approve"]);
  expect(actionsOf(s)).toEqual(["unschedule"]);
  expect(actionsOf(settle(s, { ok: true, at }))).toEqual([]);
  expect(actionsOf(failed)).toEqual(["reconnect", "retry"]);
  expect(actionsOf(settle(s, { ok: false, reason: "the platform said no", reconnect: false }))).toEqual(["retry"]);
  expect(agoWords(at, at + 5 * 60_000)).toBe("5 min ago");
  expect(agoWords(at, at + 3 * 86_400_000)).toBe("3 days ago");
});
