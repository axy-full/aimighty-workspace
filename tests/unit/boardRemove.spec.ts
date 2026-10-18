import { test, expect } from "@playwright/test";
import { isRemovable, planRemoval, restoreRecord, restoreRemoved, trashEntryOf, whyNotRemovable } from "../../lib/board/remove";
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

test("every card with a node removes, whatever its kind; a drawn frame or tile by its drawing; the rest say why not", () => {
  const nodes = [node("shot", "scene"), node("ref", "character"), node("look", "moodboard"), node("brief", "brief"), node("note", "note"), node("pic", "media")];
  const kinds = ["take", "cast", "looks", "doc", "note", "media"];
  nodes.forEach((n, i) => expect(isRemovable(card(n.id, kinds[i], n.id)), n.id).toBe(true));
  expect(isRemovable(card("frame:s1", "frame", undefined, { genId: "g1", name: "Opening", shotId: "s1" }))).toBe(true);
  expect(isRemovable(card("look:l1", "look", undefined, { genId: null }))).toBe(false);
  expect(whyNotRemovable(card("look:l1", "look", undefined, { genId: null }))).toMatch(/Nothing is drawn/);
  for (const [kind, why] of [["group", /group frame/], ["plan", /Atomik's plan/], ["cut", /approved takes/], ["deliver", /approved takes/], ["next", /suggestion/], ["versions", /Take versions/], ["take-review", /Take versions/], ["mystery", /made by the board/]] as const)
    expect(whyNotRemovable(card(`x:${kind}`, kind)), kind).toMatch(why);
  const plan = planRemoval(draft(nodes), [card("plan:run", "plan")]);
  expect(plan.refused.map((r) => r.id)).toEqual(["plan:run"]);
  expect(plan.removed).toBeNull();
  expect(plan.drawings).toEqual([]);
});

/** A draft with a drawn storyboard frame (two takes, the second picked) and a look with one take. */
const drawnDraft = (): Project => ({
  ...draft([node("note1", "note")]),
  production: { boards: { style: "live", model: "m", frames: { s1: { prompt: "", takes: [{ genId: "g2", style: "live", at: "t2" }, { genId: "g1", style: "live", at: "t1" }], selected: "g2" } }, looks: { noir: { name: "Noir", takes: [{ genId: "l1", at: "t" }], selected: "l1" } } } },
} as unknown as Project);
const held = (p: Project, scope: "frames" | "looks", key: string) => (p.production as unknown as { boards: Record<string, Record<string, { takes: { genId: string }[]; selected?: string | null }>> }).boards[scope][key];

test("a drawn frame or look is removed by its drawing (every take the draft holds on it), kept whole in the Trash, and put back as it was", () => {
  const project = drawnDraft();
  const frame = card("frame:s1", "frame", undefined, { genId: "g2", name: "Shot 1 · Wide", shotId: "s1" });
  const look = card("look:noir", "look", undefined, { genId: "l1", name: "Noir", id: "noir" });
  const plan = planRemoval(project, [frame, look, card("note1", "note", "note1")]);
  expect(held(plan.project, "frames", "s1")).toMatchObject({ takes: [], selected: null });
  expect(held(plan.project, "looks", "noir")).toMatchObject({ takes: [], selected: null });
  expect(plan.project.nodes).toEqual([]);
  expect(plan.records.map((r) => `${r.kind}:${r.itemId}`).sort()).toEqual(["frame:frame:s1", "look:look:noir", "note:note1"]);
  expect(plan.records.find((r) => r.kind === "frame")).toMatchObject({ label: "Shot 1 · Wide" });
  /* The takes themselves are not touched: no take id leaves the draft's other places, and nothing here deletes a take. */
  const back = restoreRemoved(plan.project, plan);
  expect(held(back, "frames", "s1")).toMatchObject({ takes: [{ genId: "g2" }, { genId: "g1" }], selected: "g2" });
  expect(held(back, "looks", "noir")).toMatchObject({ takes: [{ genId: "l1" }], selected: "l1" });
  expect(back.nodes.map((n) => n.id)).toEqual(["note1"]);
  /* The Trash's restore of one record, on the browser's side; a take drawn again meanwhile is left as it is. */
  const redrawn = withDrawn(plan.project, "g9");
  const one = restoreRecord(redrawn, plan.records.find((r) => r.kind === "frame")!.payload);
  expect(held(one, "frames", "s1").takes.map((t) => t.genId)).toEqual(["g2", "g1", "g9"]);
  expect(held(one, "frames", "s1").selected).toBe("g2");
  /* A frame with nothing drawn has nothing to remove. */
  expect(planRemoval(plan.project, [frame]).refused).toEqual([{ id: "frame:s1", why: "Nothing is drawn on it yet, so there is nothing to remove." }]);
});
const withDrawn = (p: Project, genId: string): Project => {
  const boards = (p.production as unknown as { boards: { frames: Record<string, unknown> } }).boards;
  return { ...p, production: { ...p.production, boards: { ...boards, frames: { ...boards.frames, s1: { prompt: "", takes: [{ genId, style: "live", at: "t9" }], selected: null } } } } } as unknown as Project;
};

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
  const back = restoreRemoved(plan.project, plan);
  expect(back.nodes.map((n) => n.id).sort()).toEqual(nodes.map((n) => n.id).sort());
  expect(back.nodes.find((n) => n.id === "viewer")!.linked).toEqual(["note1"]);
  expect(restoreRemoved(back, plan).nodes).toHaveLength(nodes.length);
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

test("a whole removal is ONE Trash record (all or nothing to record and to claim back), holding every item whole; it restores in the order taken", () => {
  const nodes = [node("a", "scene", { linked: ["inA"] }), node("inA", "media"), node("n", "note"), node("viewer", "scene", { linked: ["n"] })];
  const one = planRemoval(draft(nodes), [card("n", "note", "n")]);
  expect(trashEntryOf(one, "removal_1")).toMatchObject({ kind: "note", itemId: "removal_1", label: "Card n" });
  const many = planRemoval(draft(nodes), [card("a", "take", "a"), card("n", "note", "n")]);
  const entry = trashEntryOf(many, "removal_2")!;
  expect(entry).toMatchObject({ kind: "card", itemId: "removal_2", label: "3 cards" });
  expect((entry.payload as { items: unknown[] }).items).toHaveLength(3);
  expect(trashEntryOf(planRemoval(draft(nodes), []), "removal_3")).toBeNull();
  /* The whole record restores every node, with the links other cards had. */
  const back = restoreRecord(many.project, entry.payload);
  expect(back.nodes.map((n) => n.id).sort()).toEqual(["a", "inA", "n", "viewer"]);
  expect(back.nodes.find((n) => n.id === "viewer")!.linked).toEqual(["n"]);
});
