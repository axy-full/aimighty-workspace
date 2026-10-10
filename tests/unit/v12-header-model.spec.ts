import { test, expect } from "@playwright/test";
import { EMPTY_TABS, afterClose, closeOthers, closeTab, headerKey, openTab, parseTabs, pruneTabs, restoreTab, visibleTabs } from "../../components/v12/shell/tabs";
import { LOOK_MS, activityGroups, activityLabel, activityTone, boardStates, heldPrice } from "../../components/v12/shell/activity";
import type { TrayJob } from "../../lib/jobsTray";
import type { QueueItem } from "../../lib/control-room/queue";

/* The new header's models (components/v12/shell/tabs.ts, activity.ts): board tabs, keys and Activity. */

test("a board opened gets a tab once, at the end; closing keeps it in Recently closed; Undo puts it back where it was", () => {
  let s = openTab(openTab(openTab(EMPTY_TABS, "a"), "b"), "c");
  expect(openTab(s, "b")).toBe(s);
  expect(s.open).toEqual(["a", "b", "c"]);
  s = closeTab(s, "b");
  expect(s).toEqual({ open: ["a", "c"], closed: ["b"] });
  expect(restoreTab(s, "b", 1)).toEqual({ open: ["a", "b", "c"], closed: [] });
  /* Opening a closed board again takes it out of Recently closed. */
  expect(openTab(s, "b")).toEqual({ open: ["a", "c", "b"], closed: [] });
  expect(closeOthers(openTab(s, "d"), "c")).toEqual({ open: ["c"], closed: ["d", "a", "b"] });
});

test("Recently closed keeps five; boards that are gone drop out once the list is known", () => {
  let s = EMPTY_TABS;
  for (const id of ["1", "2", "3", "4", "5", "6", "7"]) s = closeTab(openTab(s, id), id);
  expect(s.closed).toEqual(["7", "6", "5", "4", "3"]);
  const t = { open: ["a", "gone"], closed: ["x", "b"] };
  expect(pruneTabs(t, null)).toBe(t);
  expect(pruneTabs(t, new Set(["a", "b"]))).toEqual({ open: ["a"], closed: ["b"] });
});

test("four board tabs show and the rest go under +N; the open board always shows", () => {
  const open = ["1", "2", "3", "4", "5", "6"];
  expect(visibleTabs(open.slice(0, 4), null)).toEqual({ shown: ["1", "2", "3", "4"], hidden: [] });
  expect(visibleTabs(open, "2")).toEqual({ shown: ["1", "2", "3", "4"], hidden: ["5", "6"] });
  expect(visibleTabs(open, "6")).toEqual({ shown: ["1", "2", "3", "6"], hidden: ["4", "5"] });
  expect(afterClose(["a", "b", "c"], "b")).toBe("a");
  expect(afterClose(["a", "b"], "a")).toBe("b");
  expect(afterClose(["a"], "a")).toBeNull();
});

test("a stored value that is not tabs is the empty state", () => {
  expect(parseTabs(null)).toEqual(EMPTY_TABS);
  expect(parseTabs("not json")).toEqual(EMPTY_TABS);
  expect(parseTabs(JSON.stringify({ open: ["a", 3, "a", ""], closed: "b" }))).toEqual({ open: ["a"], closed: [] });
});

test("keys: ⌘1 Home, ⌘2 Make, ⌘3… the board tabs, ⌘J Atomik's panel, G then H Home; nothing else", () => {
  expect(headerKey({ key: "1", metaKey: true })).toEqual({ go: "home" });
  expect(headerKey({ key: "2", ctrlKey: true })).toEqual({ go: "make" });
  expect(headerKey({ key: "3", metaKey: true })).toEqual({ go: "board", index: 0 });
  expect(headerKey({ key: "9", metaKey: true })).toEqual({ go: "board", index: 6 });
  expect(headerKey({ key: "j", metaKey: true })).toEqual({ toggle: "atomik" });
  expect(headerKey({ key: "g" })).toEqual({ pending: "g" });
  expect(headerKey({ key: "h" }, true)).toEqual({ go: "home" });
  expect(headerKey({ key: "h" })).toBeNull();
  expect(headerKey({ key: "k", metaKey: true })).toBeNull();
  expect(headerKey({ key: "1", metaKey: true, shiftKey: true })).toBeNull();
  expect(headerKey({ key: "a" })).toBeNull();
});

const job = (over: Partial<TrayJob>): TrayJob => ({
  id: "j1", source: "engine", kind: "video", name: "Shot 3 · take 1", mediaUrl: null, stage: "rendering", label: "Rendering", tone: "blue",
  reason: null, progress: null, createdAt: 0, settledAt: null, price: null, draftId: "b1", projectName: "Mirror film", action: "open", ...over,
});
const item = (over: Partial<QueueItem>): QueueItem => ({
  id: "q1", source: "board", title: "Approve the cast", where: "Board", at: 0, project: { productionId: "p1", draftId: "b2", name: "Launch clips" },
  price: null, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: "Cast", step: null, sample: false, approve: null, decline: null,
  open: { kind: "board", productionId: "p1", draftId: "b2" }, ...over,
} as QueueItem);

test("Activity: the pill's words and dot, the two groups, and the scope to this board", () => {
  expect(activityLabel(2, 3)).toBe("2 need you · 3 running");
  expect(activityLabel(0, 3)).toBe("3 running");
  expect(activityLabel(2, 0)).toBe("2 need you");
  expect(activityLabel(0, 0)).toBe("Activity");
  expect([activityTone(1, 1), activityTone(0, 1), activityTone(0, 0)]).toEqual(["waiting", "live", "idle"]);

  const jobs = [job({}), job({ id: "j2", stage: "complete", settledAt: 1 }), job({ id: "j3", draftId: null, projectName: null })];
  const groups = activityGroups(jobs, [item({})], { scope: "all", draftId: null, now: 4 * 60_000, heldWord: () => "7 cr" });
  expect(groups.needs.map((r) => [r.name, r.meta])).toEqual([["Approve the cast", "Launch clips · Cast"]]);
  /* Settled jobs are not running; a job made in Make says so. The held figure is the ledger's, passed in. */
  expect(groups.running.map((r) => r.meta)).toEqual(["Mirror film · Rendering · 4 min so far · 7 cr held", "Make · Rendering · 4 min so far · 7 cr held"]);
  const board = activityGroups(jobs, [item({})], { scope: "board", draftId: "b1", now: 0, heldWord: () => null });
  expect([board.needs.length, board.running.map((r) => r.id)]).toEqual([0, ["j1"]]);
  expect([...boardStates(jobs, [item({})])]).toEqual([["b1", "live"], ["b2", "waiting"]]);
});

test("Activity keeps today's failed and unconfirmed takes under Needs a look, for a day", () => {
  const now = 10 * LOOK_MS;
  const jobs = [
    job({ id: "f1", stage: "failed", label: "Failed · not billed", settledAt: now - 1000 }),
    job({ id: "u1", stage: "unconfirmed", label: "Not confirmed yet", settledAt: null }),
    job({ id: "old", stage: "failed", settledAt: now - LOOK_MS - 1 }),
    job({ id: "done", stage: "complete", settledAt: now - 1000 }),
  ];
  const groups = activityGroups(jobs, [], { scope: "all", draftId: null, now, heldWord: () => null });
  expect(groups.look.map((row) => row.id)).toEqual(["f1", "u1"]);
  expect(groups.look[0].meta).toContain("Failed · not billed");
  expect(groups.running.map((row) => row.id)).not.toContain("f1");
});

test("'held' is said only of the ledger's own reservation, never a connected account's quote", () => {
  const label = (price: { amount: number; unit: string }) => `${price.amount} ${price.unit}`;
  expect(heldPrice({ source: "engine", stage: "rendering", price: { amount: 7, unit: "cr" } }, label)).toBe("7 cr");
  expect(heldPrice({ source: "engine", stage: "confirming", price: { amount: 0.7, unit: "usd" } }, label)).toBe("0.7 usd");
  expect(heldPrice({ source: "account", stage: "rendering", price: { amount: 7, unit: "account-cr" } }, label)).toBeNull();
  expect(heldPrice({ source: "engine", stage: "rendering", price: { amount: 7, unit: "account-cr" } }, label)).toBeNull();
  expect(heldPrice({ source: "engine", stage: "rendering", price: null }, label)).toBeNull();
});

test("a take queued for a free slot holds nothing yet: its figure is the start's price, never said as held", () => {
  const label = (price: { amount: number; unit: string }) => `${price.amount} ${price.unit}`;
  /* As lib/jobsTray.ts writes a slot wait: stage queued, its price the release quote (money.needs); nothing is reserved
     until the take starts (lib/generationAdmission.ts). */
  const waiting = job({ id: "slot", stage: "queued", label: "Queued", reason: "Waiting for a free slot", price: { amount: 43, unit: "cr" } });
  expect(heldPrice(waiting, label)).toBeNull();
  expect(heldPrice({ ...waiting, stage: "submitting" }, label)).toBeNull();
  const started = job({ id: "go", price: { amount: 43, unit: "cr" } });
  const groups = activityGroups([waiting, started], [], { scope: "all", draftId: null, now: 60_000, heldWord: (j) => heldPrice(j, label) });
  expect(groups.running.map((r) => r.meta)).toEqual(["Mirror film · Queued · 1 min so far", "Mirror film · Rendering · 1 min so far · 43 cr held"]);
});
