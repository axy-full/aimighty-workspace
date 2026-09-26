import { test, expect } from "@playwright/test";
import { DraftRequestError } from "../../lib/workbench/draft-request";
import type { CanvasNode } from "../../lib/workbench/studio";
import type { TeamPatch } from "../../lib/workbench/team-canvas-model";
import { mergePatches, sendFailure, TeamOutbox } from "../../lib/workspace/team-canvas-outbox";

/* The Rig's team canvas outbox: an edit is only ever sent to the production it was made in. */

const node = (id: string, title = id): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 238, linked: [] });
const patch = (nodes: CanvasNode[], at: number, extra: Partial<TeamPatch> = {}): TeamPatch => ({ upsertNodes: nodes, removeNodes: [], upsertAssets: [], order: null, at, ...extra });

test("an edit waiting for production A is still sent to A after the person moves to production B", () => {
  const outbox = new TeamOutbox();
  outbox.add("prod-a", patch([node("a1")], 1));
  /* A's send fails (the connection dropped); the person opens B and edits there. */
  const [[pid, first]] = outbox.take();
  expect(pid).toBe("prod-a");
  outbox.keep(pid, first);
  outbox.add("prod-b", patch([node("b1")], 2));
  const retried = Object.fromEntries(outbox.take());
  expect(Object.keys(retried).sort()).toEqual(["prod-a", "prod-b"]);
  expect(retried["prod-a"].upsertNodes.map((n) => n.id)).toEqual(["a1"]);
  expect(retried["prod-b"].upsertNodes.map((n) => n.id)).toEqual(["b1"]);
  expect(outbox.size).toBe(0);
});

test("a kept edit rides under the edits made since, and the newer write of a node wins", () => {
  const outbox = new TeamOutbox();
  outbox.add("prod-a", patch([node("a1", "Old")], 1, { order: ["a1"] }));
  const [[pid, sent]] = outbox.take();
  outbox.add("prod-a", patch([node("a1", "New"), node("a2")], 2, { order: ["a1", "a2"] }));
  outbox.keep(pid, sent);
  const [[, merged]] = outbox.take();
  expect(merged.upsertNodes.map((n) => [n.id, n.title])).toEqual([["a1", "New"], ["a2", "a2"]]);
  expect(merged.order).toEqual(["a1", "a2"]);
  expect(merged.at).toBe(2);
});

test("an older send that fails after a newer one went out is never re-sent over it", () => {
  const outbox = new TeamOutbox();
  /* Send 1 carries a1 and a2 and is still in flight (a keepalive PATCH can take up to 20 s). */
  outbox.add("prod-a", patch([node("a1", "Old"), node("a2", "Two")], 1, { order: ["a1", "a2"] }));
  const [[pid, first]] = outbox.take();
  /* The person edits a1 again and the draft save's flush sends it at once: send 2 lands. */
  outbox.add("prod-a", patch([node("a1", "New")], 2, { order: ["a2", "a1"] }));
  outbox.take();
  /* Send 1 then fails. Only what no later send carried goes back: a2, not the old a1 or the old order. */
  outbox.keep(pid, first);
  const [[, retried]] = outbox.take();
  expect(retried.upsertNodes.map((n) => [n.id, n.title])).toEqual([["a2", "Two"]]);
  expect(retried.order).toBeNull();
});

test("the same holds while the newer send is still in flight: it lands or is kept itself", () => {
  const outbox = new TeamOutbox();
  outbox.add("prod-a", patch([node("a1", "Old")], 1));
  const [[, first]] = outbox.take();
  outbox.add("prod-a", patch([node("a1", "New")], 2));
  const [[, second]] = outbox.take();
  /* The older send fails first: nothing of it is newer than the send behind it. */
  outbox.keep("prod-a", first);
  expect(outbox.size).toBe(0);
  /* Then the newer one fails too: it is the one retried. */
  outbox.keep("prod-a", second);
  const [[, retried]] = outbox.take();
  expect(retried.upsertNodes.map((n) => n.title)).toEqual(["New"]);
});

test("send numbers are per production: a later send to B takes nothing off A's retry", () => {
  const outbox = new TeamOutbox();
  outbox.add("prod-a", patch([node("x", "A's x")], 1));
  const [[, first]] = outbox.take();
  outbox.add("prod-b", patch([node("x", "B's x")], 2));
  outbox.take();
  outbox.keep("prod-a", first);
  const [[pid, retried]] = outbox.take();
  expect(pid).toBe("prod-a");
  expect(retried.upsertNodes.map((n) => n.title)).toEqual(["A's x"]);
});

test("merging keeps removals and re-additions straight", () => {
  const removed = mergePatches(patch([node("x")], 1), patch([], 2, { removeNodes: ["x"] }));
  expect(removed.upsertNodes).toEqual([]);
  expect(removed.removeNodes).toEqual(["x"]);
  const back = mergePatches(removed, patch([node("x")], 3));
  expect(back.upsertNodes.map((n) => n.id)).toEqual(["x"]);
  expect(back.removeNodes).toEqual([]);
});

test("a refused edit is dropped; a lost connection or a server fault is retried", () => {
  expect(sendFailure(new DraftRequestError("Check the canvas edit before saving.", false))).toBe("refused");
  expect(sendFailure(new DraftRequestError("Your session expired."))).toBe("refused");
  expect(sendFailure(new DraftRequestError("Connection interrupted.", true, true))).toBe("retry");
  expect(sendFailure(new DraftRequestError("Studio could not load this project (503).", true))).toBe("retry");
  expect(sendFailure(new TypeError("Failed to fetch"))).toBe("retry");
});
