import { test, expect } from "@playwright/test";
import { newPaletteIndex, searchNewPalette } from "../../lib/shell/palette";
import { askButton, atomikIntent, isHowQuestion, matchPlace, thinkingLine } from "../../lib/shell/atomik-panel";
import { selectBatch, type QueueItem } from "../../lib/control-room/queue";

/*
 * ⌘K in the new interface (design/particl-graphite README § 3.4, Atomik frames a–e): the index, the search,
 * what a typed line is, and the words on Atomik's buttons. Pure; nothing here can spend.
 */

const RAIL = [
  { id: "brief", label: "Brief" }, { id: "looks", label: "Looks" }, { id: "storyboard", label: "Storyboard" }, { id: "shots", label: "Shots" },
  { id: "cast", label: "Cast" }, { id: "cut", label: "Cut" }, { id: "deliver", label: "Deliver" },
];
const index = newPaletteIndex({ rail: RAIL, models: [{ id: "m1", name: "Engine one", kind: "Video" }], assets: [{ id: "a1", name: "The mirrored plate", kind: "image" }] });

test("the empty palette lists Home, the board's places, Make's types and tools, Atomik and Settings' five sections", () => {
  const first = searchNewPalette(index, "");
  expect(first.map((r) => `${r.group}:${r.label}`)).toEqual([
    "Home:Home", "Board:Brief", "Board:Looks", "Board:Storyboard", "Board:Shots", "Board:Cast", "Board:Cut", "Board:Deliver", "Board:Ads", "Board:Social",
    "Make:Video", "Make:Image", "Make:Audio", "Make:Motion transfer", "Make:Object swap", "Atomik:Atomik",
    "Settings:Team", "Settings:Plan & credits", "Settings:Spending rules", "Settings:Connections", "Settings:Advanced",
  ]);
  expect(first.find((r) => r.label === "Image")?.run).toEqual({ type: "gen", tool: "image" });
  expect(first.find((r) => r.label === "Atomik")?.hint).toBe("Approvals · Activity · Skills · Memory");
  expect(first[0].hint).toBe("What needs you");
});

test("the index reaches the control room, Settings' five sections and assets", () => {
  const labels = (q: string) => searchNewPalette(index, q).map((r) => r.run);
  expect(labels("activity")[0]).toEqual({ type: "control", page: "runs" });
  expect(labels("spending rules")[0]).toEqual({ type: "settings", section: "rules" });
  expect(labels("plan & credits")[0]).toEqual({ type: "settings", section: "credits" });
  expect(labels("mirrored")[0]).toEqual({ type: "asset", id: "a1" });
  expect(labels("motion transfer")[0]).toEqual({ type: "gen", tool: "motion" });
});

test("the new search never adds an \"Ask Atomik\" row: Atomik answers in its card", () => {
  expect(searchNewPalette(index, "zzzz")).toEqual([]);
  expect(searchNewPalette(index, "cast").some((r) => r.run.type === "ask")).toBe(false);
});

test("go to <place> pins its place first, on the board it names", () => {
  const intent = atomikIntent("go to cast");
  expect(intent).toEqual({ kind: "go", text: "go to cast", place: "cast" });
  const place = matchPlace(intent.kind === "go" ? intent.place : "", RAIL);
  expect(place?.id).toBe("cast");
  const rows = searchNewPalette(index, "go to cast", { goTo: place, board: "Studio" });
  expect(rows[0]).toEqual({ group: "Board", label: "Go to Cast", hint: "On the Studio board", run: { type: "region", region: "cast" } });
  expect(matchPlace("the moon", RAIL)).toBeNull();
  expect(matchPlace("storyboards", RAIL)?.id).toBe("storyboard");
});

test("what a typed line is: commands, then questions, then requests", () => {
  expect(atomikIntent("  ")).toEqual({ kind: "empty" });
  expect(atomikIntent("approve everything under 10 cr")).toMatchObject({ kind: "approve", under: 10 });
  expect(atomikIntent("Approve everything under 50 cr")).toMatchObject({ kind: "approve", under: 50 });
  expect(atomikIntent("approve everything")).toMatchObject({ kind: "approve", under: 10 });
  expect(atomikIntent("make shot 2 warmer")).toMatchObject({ kind: "make", words: "shot 2 warmer" });
  expect(atomikIntent("remember our brand is quiet")).toMatchObject({ kind: "memory", verb: "remember", subject: "our brand is quiet" });
  expect(atomikIntent("forget the old logo")).toMatchObject({ kind: "memory", verb: "forget" });
  expect(atomikIntent("How do I add a reference to a shot?")).toMatchObject({ kind: "how" });
  expect(atomikIntent("which engine is cheapest")).toMatchObject({ kind: "how" });
  expect(atomikIntent("a fifteen second film about a desert")).toMatchObject({ kind: "ask" });
  expect(isHowQuestion("Plan three shots?")).toBe(true);
  expect(isHowQuestion("Plan three shots")).toBe(false);
});

test("the Ask button: free for a question or a command, the server's figure for a request, never a design figure", () => {
  const none = { credits: null, loading: false, error: null };
  expect(askButton(atomikIntent("how do I upload?"), none)).toMatchObject({ label: "Ask · free", disabled: false });
  expect(askButton(atomikIntent(""), none)).toMatchObject({ label: "Ask · free" });
  expect(askButton(atomikIntent("plan the film"), { credits: 14, loading: false, error: null })).toMatchObject({ label: "Ask · up to 14 cr", disabled: false, price: { kind: "up-to", credits: 14 } });
  /* A ceiling is never shown below the whole credit it can be charged. */
  expect(askButton(atomikIntent("plan the film"), { credits: 13.2, loading: false, error: null }).label).toBe("Ask · up to 14 cr");
  expect(askButton(atomikIntent("plan the film"), { credits: null, loading: true, error: null })).toMatchObject({ label: "Ask", disabled: true });
  expect(askButton(atomikIntent("plan the film"), { credits: null, loading: false, error: "No priced model." })).toMatchObject({ disabled: true, reason: "No priced model." });
  for (const credits of [0.4, 4, 24, 140]) expect(askButton(atomikIntent("plan"), { credits, loading: false, error: null }).label).not.toMatch(/quoted|about/);
});

test("the thinking line says what thinking may cost, or that a question is free", () => {
  expect(thinkingLine(atomikIntent("how do I invite someone?"), null)).toBe("A question about Particl · answered free");
  expect(thinkingLine(atomikIntent("plan the film"), 24)).toBe("Atomik’s thinking may cost up to 24 cr · it plans and prices first; nothing is spent without your approval");
  expect(thinkingLine(atomikIntent("plan the film"), null)).not.toMatch(/\d/);
});

/* ⌘K's approve card reads the one queue (stream 8): what it covers is selectBatch's, never a list of its own. */
const item = (id: string, credits: number, more: Partial<QueueItem> = {}): QueueItem => ({
  id, source: "held", title: id, where: "Make", at: 1, project: { productionId: "p", draftId: "d", name: "A project" },
  price: { kind: "exact", credits }, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: id, credits }, decline: { kind: "discard", genId: id }, open: { kind: "take", genId: id, draftId: "d" }, ...more,
});
test("approve everything under N cr: strictly under, admin items left out, the total in price words", () => {
  const items = [item("a", 3), item("b", 9), item("c", 10), item("d", 43, { needsAdmin: true }), item("e", 1, { sample: true })];
  const under10 = selectBatch(items, 10);
  expect(under10.items.map((i) => i.id)).toEqual(["a", "b"]);
  expect(under10.total).toEqual({ kind: "exact", credits: 12 });
  const under50 = selectBatch(items, 50);
  expect(under50.adminOut.map((i) => i.id)).toEqual(["d"]);
  expect(under50.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
});
