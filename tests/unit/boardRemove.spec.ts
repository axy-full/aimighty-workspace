import { test, expect } from "@playwright/test";
import { isRemovable, planRemoval, restoreRecord, restoreRemoved, whyNotRemovable } from "../../lib/board/remove";
import { newProject, type CanvasNode, type Project } from "../../lib/workbench/studio";
import type { BoardCard } from "../../lib/board/types";

/**
 * Removing cards from a board (lib/board/remove.ts): every kind of card with a node of its own is removable, a drawn frame or tile by its take, the rest say why
 * not; a whole selection is ONE edit (so a mix of shots and free cards never brings one back); a locked card refuses in its own words; the Undo and the Trash's
 * restore put a node back with the links other cards had to it. Pure: no browser, no server.
 */
const node = (id: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type, title: `Card ${id}`, x: 0, y: 0, width: 200, linked: [], ...extra } as CanvasNode);
const card = (id: string, kind: string, nodeId?: string, data: unknown = { title: `Card ${id}` }): Pick<BoardCard, "id" | "kind" | "nodeId" | "data"> => ({ id, kind, ...(nodeId ? { nodeId } : {}), data });
const draft = (nodes: CanvasNode[]): Project => ({ ...newProject("D"), nodes });

test("every card with a node removes, whatever its kind; a drawn frame or tile by its take; the rest say why not", () => {
  const nodes = [node("shot", "scene"), node("ref", "character"), node("look", "moodboard"), node("brief", "brief"), node("note", "note"), node("pic", "media")];
  const kinds = ["take", "cast", "looks", "doc", "note", "media"];
  nodes.forEach((n, i) => expect(isRemovable(card(n.id, kinds[i], n.id)), n.id).toBe(true));
  expect(isRemovable(card("frame:s1", "frame", undefined, { genId: "g1", name: "Opening" }))).toBe(true);
  expect(isRemovable(card("look:l1", "look", undefined, { genId: null }))).toBe(false);
  expect(whyNotRemovable(card("look:l1", "look", undefined, { genId: null }))).toMatch(/Nothing is drawn/);
  for (const [kind, why] of [["group", /group frame/], ["plan", /Atomik's plan/], ["cut", /approved takes/], ["deliver", /approved takes/], ["next", /suggestion/], ["versions", /Take versions/], ["take-review", /Take versions/], ["mystery", /made by the board/]] as const)
    expect(whyNotRemovable(card(`x:${kind}`, kind)), kind).toMatch(why);
  const plan = planRemoval(draft(nodes), [card("frame:s1", "frame", undefined, { genId: "g1", name: "Opening" }), card("plan:run", "plan")]);
  expect(plan.takes).toEqual([{ cardId: "frame:s1", genId: "g1", label: "Opening" }]);
  expect(plan.refused.map((r) => r.id)).toEqual(["plan:run"]);
  expect(plan.removed).toBeNull();
});

test("a whole selection is one edit: shots and free cards together, once, and the cards other cards linked are unlinked, never revived", () => {
  const nodes = [node("shotA", "scene", { linked: ["inA"] }), node("shotB", "scene"), node("inA", "media"), node("note1", "note"), node("keep", "note"), node("viewer", "scene", { linked: ["note1"] })];
  const cards = [card("shotA", "take", "shotA"), card("note1", "note", "note1"), card("shotB", "take", "shotB")];
  const plan = planRemoval(draft(nodes), cards);
  /* One draft out of one reading: gone are the three selected, and the input only shotA used. */
  expect(plan.project.nodes.map((n) => n.id).sort()).toEqual(["keep", "viewer"]);
  expect(plan.alsoGone).toEqual(["inA"]);
  expect(plan.project.nodes.find((n) => n.id === "viewer")!.linked).toEqual([]);
  /* One Trash record per node, each keeping the node and the links other cards had to it. */
  expect(plan.records.map((r) => r.itemId).sort()).toEqual(["inA", "note1", "shotA", "shotB"]);
  expect(plan.records.find((r) => r.itemId === "note1")).toMatchObject({ kind: "note", label: "Card note1" });
  expect(plan.records.find((r) => r.itemId === "note1")!.payload).toMatchObject({ node: { id: "note1" }, links: [{ nodeId: "viewer", linked: ["note1"] }] });
  /* The Undo puts every node back with its links, once. */
  const back = restoreRemoved(plan.project, plan.removed!);
  expect(back.nodes.map((n) => n.id).sort()).toEqual(nodes.map((n) => n.id).sort());
  expect(back.nodes.find((n) => n.id === "viewer")!.linked).toEqual(["note1"]);
  expect(restoreRemoved(back, plan.removed!).nodes).toHaveLength(nodes.length);
  /* The Trash's restore of one record, on the browser's side. */
  const one = restoreRecord(plan.project, plan.records.find((r) => r.itemId === "note1")!.payload);
  expect(one.nodes.map((n) => n.id).sort()).toEqual(["keep", "note1", "viewer"]);
  expect(one.nodes.find((n) => n.id === "viewer")!.linked).toEqual(["note1"]);
});

test("a locked card refuses the removal in its own words and nothing leaves; a card already gone is refused", () => {
  const nodes = [node("shotA", "scene", { locked: true, title: "Opening" }), node("note1", "note")];
  expect(() => planRemoval(draft(nodes), [card("shotA", "take", "shotA"), card("note1", "note", "note1")])).toThrow(/Unlock Opening before removing it/);
  const gone = planRemoval(draft(nodes), [card("ghost", "note", "ghost")]);
  expect(gone.removed).toBeNull();
  expect(gone.refused).toEqual([{ id: "ghost", why: "That card is already gone." }]);
});
