import { test, expect } from "@playwright/test";
import { historyEntries, initialsOf, type LoggedChange } from "../../lib/board/history";

/* Stream 3 · History's words (lib/board/history.ts): what changed, by whom; nothing about money or prompts. */
const row = (seq: number, what: string, author: string, changes: LoggedChange["changes"], focus: string | null = null): LoggedChange => ({ seq, at: seq * 1000, what, author, changes, focus });
const names = new Map([["u1", "Rowan Field"]]);

test("each logged change says what happened and who did it", () => {
  const entries = historyEntries([
    row(5, "tidy", "u1", [{ id: "a" }, { id: "b" }]),
    row(4, "agent", "agent:rar_1", [{ id: "c", made: true, after: { title: "Wide" } }, { id: "d", made: true }], "c"),
    row(3, "agent-undo", "agent:rar_1", [{ id: "c", removed: true, before: { title: "Wide" } }]),
    row(2, "ops", "u1", [{ id: "e", made: true, after: { title: "Keep the camera low" } }]),
    row(1, "import", "u1", [{ id: "f" }]),
  ], names);
  expect(entries.map((e) => [e.who.kind, e.who.initials, e.text, e.card])).toEqual([
    ["person", "RF", "Tidied the board · 2 cards moved", "a"],
    ["atomik", "AT", "Built on the board · 2 cards", "c"],
    ["atomik", "AT", "Took its build off the board · 1 card", null],
    ["person", "RF", "Added Keep the camera low", "e"],
    ["person", "RF", "Brought an old board across", "f"],
  ]);
});

test("a change nobody in the workspace made (the server's own) is left out", () => {
  expect(historyEntries([row(1, "ops", "server", [{ id: "a" }]), row(2, "ops", "someone-else", [{ id: "b" }])], names)).toEqual([]);
  expect([initialsOf("Rowan Field"), initialsOf("cher"), initialsOf("  ")]).toEqual(["RF", "C", "?"]);
});

test("a Make result reaches the board of its own project only", async () => {
  const { boardMade, onBoardMade } = await import("../../lib/board/made");
  const got: string[] = [];
  const stop = onBoardMade("p1", (made) => got.push(made.nodeId));
  boardMade({ projectId: "p2", nodeId: "other" });
  boardMade({ projectId: "p1", nodeId: "n1" });
  stop();
  boardMade({ projectId: "p1", nodeId: "n2" });
  expect(got).toEqual(["n1"]);
});
