import { test, expect } from "@playwright/test";
import {
  rowsOf, detailOf, orderBadges, sameBinding, consequenceOf, saveLabel,
  renderPrice, lockNote, takeLine, secondsLine, madeHere, effectiveVersion, follows, rowKey,
  candidatesFor, emptyNote, countLine,
  type ElementIn, type BindingIn,
} from "../../lib/shotBindings";

/* One shot's five slots (SOW §9, surface 2c). The surface's whole claim is
   "change a slot and only this shot moves", so what is tested here is that a
   row says what it actually is — pinned, locked, changed, promoted — because
   a badge that lies is the claim broken. */

const version = (id: string, label: string, status = "ready") => ({ id, label, status });

const cass: ElementIn = {
  id: "el-cass", kind: "character", name: "Cass", locked: false, fromShotId: null,
  attributes: [
    { id: "at-face", kind: "face", label: "face", currentId: "f3", locked: true,
      versions: [version("f1", ""), version("f2", ""), version("f3", "")] },
    { id: "at-hair", kind: "hair", label: "hair", currentId: "h1", locked: true,
      versions: [version("h1", "")] },
    { id: "at-ward", kind: "wardrobe", label: "wardrobe", currentId: "w2", locked: false,
      versions: [version("w1", "waxed coat"), version("w2", "overalls")] },
  ],
};

const workshop: ElementIn = {
  id: "el-shop", kind: "location", name: "Workshop", locked: false, fromShotId: null,
  attributes: [
    { id: "at-plate", kind: "plate", label: "plate", currentId: "p1", locked: false,
      versions: [version("p1", "north wall"), version("p2", "bench"), version("p3", "door")] },
  ],
};

const mule: ElementIn = {
  id: "el-mule", kind: "prop", name: "The Mule", locked: false, fromShotId: "sh3",
  attributes: [
    { id: "at-turn", kind: "turntable", label: "view", currentId: "t1", locked: false,
      versions: [version("t1", "")] },
  ],
};

const look: ElementIn = {
  id: "el-look", kind: "look", name: "Bleach bypass", locked: true, fromShotId: null,
  attributes: [
    { id: "at-grade", kind: "grade", label: "grade", currentId: "g2", locked: false,
      versions: [version("g1", ""), version("g2", "")] },
  ],
};

const ELEMENTS = [cass, workshop, mule, look];

const bind = (slot: string, elementId: string, attributeId: string | null, versionId: string | null): BindingIn =>
  ({ slot: slot as BindingIn["slot"], ordinal: 0, elementId, attributeId, versionId });

test("five rows come back in the handoff's order, bound or not", () => {
  const rows = rowsOf("sh3", [], ELEMENTS);
  expect(rows.map((r) => r.slot)).toEqual(["character", "background", "element", "look", "keyframe"]);
  // An unbound slot is a row and not an absence: it is where a wire goes next.
  expect(rows.every((r) => r.elementId === null)).toBe(true);
  expect(rows[0].badges).toEqual([]);
});

test("a version on the binding is an override; no version follows current", () => {
  const following = rowsOf("sh3", [bind("character", "el-cass", "at-ward", null)], ELEMENTS);
  expect(following[0].badges).not.toContain("override");

  const pinned = rowsOf("sh3", [bind("character", "el-cass", "at-ward", "w1")], ELEMENTS);
  expect(pinned[0].badges).toContain("override");

  /* Pinning to the SAME id current happens to hold is still a pin: it will
     not move when the library moves, which is the whole difference. */
  const pinnedToCurrent = rowsOf("sh3", [bind("character", "el-cass", "at-ward", "w2")], ELEMENTS);
  expect(pinnedToCurrent[0].badges).toContain("override");
});

test("an element promoted from THIS shot says so, and one promoted elsewhere does not", () => {
  const here = rowsOf("sh3", [bind("element", "el-mule", null, null)], ELEMENTS);
  expect(here[2].badges).toContain("created");
  expect(here[2].detail).toBe("created here");

  const elsewhere = rowsOf("sh9", [bind("element", "el-mule", null, null)], ELEMENTS);
  expect(elsewhere[2].badges).not.toContain("created");
});

test("a lock on the element and a lock on the attribute both lock the row", () => {
  const byElement = rowsOf("sh3", [bind("look", "el-look", "at-grade", null)], ELEMENTS);
  expect(byElement[3].locked).toBe(true);
  expect(byElement[3].badges).toContain("locked");
  expect(lockNote(byElement[3])).toContain("Bleach bypass");

  const byAttribute = rowsOf("sh3", [bind("character", "el-cass", "at-face", null)], ELEMENTS);
  expect(byAttribute[0].locked).toBe(true);

  // An unlocked attribute on an unlocked element is not locked by association.
  const open = rowsOf("sh3", [bind("character", "el-cass", "at-ward", null)], ELEMENTS);
  expect(open[0].locked).toBe(false);
  expect(lockNote(open[0])).toBe("");
});

test("changed is a comparison against what is saved, not a memory of a tap", () => {
  const saved = [bind("background", "el-shop", "at-plate", null)];

  // Picking plate 2 is a change.
  const moved = rowsOf("sh3", saved, ELEMENTS, { "background:0": bind("background", "el-shop", "at-plate", "p2") });
  expect(moved[1].badges).toContain("changed");

  /* Picking what is already bound is NOT a change and must not price. This
     is the one that decides whether a footer can read 29 cr for nothing. */
  const same = rowsOf("sh3", saved, ELEMENTS, { "background:0": bind("background", "el-shop", "at-plate", null) });
  expect(same[1].badges).not.toContain("changed");
});

test("badges are ordered by what can be done about them", () => {
  expect(orderBadges(["created", "override", "locked", "changed"]))
    .toEqual(["changed", "locked", "override", "created"]);
  // Deduplicated, so a row cannot say OVERRIDE twice.
  expect(orderBadges(["override", "override"])).toEqual(["override"]);
});

test("the detail line is derived, never a sentence about one production", () => {
  // A bundle reads out every attribute at its current version.
  expect(detailOf(cass, bind("character", "el-cass", null, null), "sh3"))
    .toBe("face v3 · hair v1 · wardrobe v2");

  /* A binding that names an attribute reaches only that one; reading out the
     others would describe versions this shot never asked for. */
  expect(detailOf(cass, bind("character", "el-cass", "at-ward", "w1"), "sh3"))
    .toBe("v1 of 2 wardrobes");

  // One attribute, several versions: which of them this shot took.
  expect(detailOf(workshop, bind("background", "el-shop", null, null), "sh3"))
    .toBe("v1 of 3 plates");

  // Promotion outranks everything: it is the fact the row exists to carry.
  expect(detailOf(mule, bind("element", "el-mule", null, null), "sh3")).toBe("created here");
});

test("the version strip numbers by position and marks current apart from pinned", () => {
  const rows = rowsOf("sh3", [bind("background", "el-shop", "at-plate", "p3")], ELEMENTS);
  const strip = rows[1].versions;
  expect(strip.map((v) => v.line)).toEqual(["v1 north wall", "v2 bench", "v3 door"]);
  // Current is the library's; inUse is this shot's. On a pinned row they differ.
  expect(strip.find((v) => v.current)!.id).toBe("p1");
  expect(strip.find((v) => v.inUse)!.id).toBe("p3");

  /* Following current selects NO tile. One choice may not have two selected
     states: lighting the current tile as well as the Follow card is how a
     person is left unable to say which one is in force. */
  const follow = rowsOf("sh3", [bind("background", "el-shop", "at-plate", null)], ELEMENTS);
  const s2 = follow[1].versions;
  expect(s2.some((v) => v.inUse)).toBe(false);
  expect(s2.find((v) => v.current)!.id).toBe("p1");
  expect(follows(follow[1])).toBe(true);
  expect(follows(rows[1])).toBe(false);
});

test("a version still rendering is offered but not pickable", () => {
  const pending: ElementIn = {
    ...workshop,
    attributes: [{ ...workshop.attributes[0], versions: [version("p1", "north wall"), version("p2", "bench", "pending")] }],
  };
  const rows = rowsOf("sh3", [bind("background", "el-shop", "at-plate", null)], [pending]);
  expect(rows[1].versions.map((v) => v.ready)).toEqual([true, false]);
});

test("the consequence separates what a save does from what a render costs", () => {
  const clean = rowsOf("sh3", [bind("background", "el-shop", "at-plate", null)], ELEMENTS);
  expect(consequenceOf(clean, 29, true)).toContain("APPROVED TAKE STANDS");
  expect(consequenceOf(clean, 29, true)).not.toContain("29 CR");

  const dirty = rowsOf("sh3", [bind("background", "el-shop", "at-plate", null)], ELEMENTS,
    { "background:0": bind("background", "el-shop", "at-plate", "p2") });
  const line = consequenceOf(dirty, 29, true);
  expect(line).toContain("BACKGROUND");
  // The approved take is not changed by a save, and the sentence has to say so.
  expect(line).toContain("KEEPS THE OLD VERSION");
  expect(line).toContain("29 CR");

  // With nothing approved there is nothing to hold to, so it says the other thing.
  expect(consequenceOf(dirty, 29, false)).toContain("NEXT TAKE");
});

test("the footer says what each button does, and only one of them spends", () => {
  const clean = rowsOf("sh3", [], ELEMENTS);
  expect(saveLabel(clean)).toBe("Nothing to save");

  const one = rowsOf("sh3", [bind("background", "el-shop", "at-plate", null)], ELEMENTS,
    { "background:0": bind("background", "el-shop", "at-plate", "p2") });
  expect(saveLabel(one)).toBe("Save this change");

  const two = rowsOf("sh3",
    [bind("background", "el-shop", "at-plate", null), bind("character", "el-cass", "at-ward", null)],
    ELEMENTS,
    {
      "background:0": bind("background", "el-shop", "at-plate", "p2"),
      "character:0": bind("character", "el-cass", "at-ward", "w1"),
    });
  expect(saveLabel(two)).toBe("Save 2 changes");

  // The price is on the action that spends, and on no other.
  expect(renderPrice(29)).toBe("Rendering it again · 29 cr");
  /* Refused: no price on an action that cannot be taken, but the way out
     stays open — a person at a cap goes to the composer to see the cap. */
  expect(renderPrice(29, false)).toBe("Can't render yet · see above");
});

test("the take strip reads what is there, and says so when there is nothing", () => {
  expect(takeLine(null)).toBe("NO TAKE YET");
  expect(takeLine({ version: 2, approved: true, seconds: 3, credits: 29 }))
    .toBe("v2 · APPROVED · 0:03 · 29 CR");
  expect(takeLine({ version: 1, approved: false, seconds: null, credits: 12 }))
    .toBe("v1 · DRAFT · 12 CR");
  expect(secondsLine(75)).toBe("1:15");
});

test("two bindings are the same when every part of the port is", () => {
  const a = bind("character", "el-cass", "at-ward", "w1");
  expect(sameBinding(a, { ...a })).toBe(true);
  expect(sameBinding(a, { ...a, versionId: null })).toBe(false);
  expect(sameBinding(a, { ...a, attributeId: null })).toBe(false);
  expect(sameBinding(a, { ...a, ordinal: 1 })).toBe(false);
  expect(sameBinding(null, null)).toBe(true);
  expect(sameBinding(a, null)).toBe(false);
});

test("what this shot put into the library is the shot's own, not the production's", () => {
  expect(madeHere(ELEMENTS, "sh3").map((e) => e.id)).toEqual(["el-mule"]);
  expect(madeHere(ELEMENTS, "sh9")).toEqual([]);
});

test("the effective version is the pin, and current only when there is no pin", () => {
  const ward = cass.attributes[2];
  expect(effectiveVersion(ward, "w1")!.id).toBe("w1");
  expect(effectiveVersion(ward, null)!.id).toBe("w2");
  // A pin at a version that has been deleted resolves to nothing rather than
  // silently falling back to current, which would hide the broken wire.
  expect(effectiveVersion(ward, "gone")).toBeNull();
});

test("a second character on the same slot gets its own row, not the first one's", () => {
  /* Rule 6: a wire lands on a SLOT, not a node, and `ordinal` is on the
     binding because a shot can hold two of them. Keying rows by slot alone
     hid the second one — the shot would render with a character the screen
     never showed. */
  const two = [
    { ...bind("character", "el-cass", "at-ward", null), ordinal: 0 },
    { ...bind("character", "el-mule", "at-turn", "t1"), ordinal: 1 },
  ];
  const rows = rowsOf("sh9", two, ELEMENTS);
  const chars = rows.filter((r) => r.slot === "character");
  expect(chars).toHaveLength(2);
  expect(chars.map((r) => r.name)).toEqual(["Cass", "The Mule"]);
  // Numbered only when there is more than one, so the ordinary shot reads as drawn.
  expect(chars.map((r) => r.label)).toEqual(["CHARACTER 1", "CHARACTER 2"]);
  expect(rows.find((r) => r.slot === "background")!.label).toBe("BACKGROUND");
  // Six rows: five slots, one of them twice.
  expect(rows).toHaveLength(6);

  // And an edit to the second does not touch the first.
  const edited = rowsOf("sh9", two, ELEMENTS,
    { [rowKey("character", 1)]: { ...two[1], versionId: "t2" } });
  const c2 = edited.filter((r) => r.slot === "character");
  expect(c2[0].badges).not.toContain("changed");
  expect(c2[1].badges).toContain("changed");
});

test("an empty slot is still one row, and only one", () => {
  const rows = rowsOf("sh9", [], ELEMENTS);
  expect(rows).toHaveLength(5);
  expect(rows.every((r) => r.elementId === null)).toBe(true);
  expect(rowKey("character", 0)).toBe("character:0");
});

test("a bundle keeps its port, and narrows only when somebody says which", () => {
  /* attributeId null is the bundle: every attribute at its current version.
     Falling back to the element's FIRST attribute rewrote the port — expand
     the row, pick anything, and the save dropped the other three ports off
     the shot without a word. So the row's own attributeId stays null, and the
     attributes are offered as a SECOND step: narrowing is a decision. */
  const rows = rowsOf("sh3", [bind("character", "el-cass", null, null)], ELEMENTS);
  expect(rows[0].attributeId).toBeNull();
  expect(rows[0].versions).toEqual([]);
  expect(rows[0].detail).toBe("face v3 · hair v1 · wardrobe v2");
  // Not pinned, because it is not.
  expect(rows[0].badges).not.toContain("override");

  // Every attribute that has versions is offered, with where it stands.
  expect(rows[0].bundle.map((b) => `${b.label} ${b.at}`))
    .toEqual(["face v3", "hair v1", "wardrobe v2"]);
  // A locked attribute is offered but says so, rather than being hidden and
  // then refused by the route after the surface has priced the save.
  expect(rows[0].bundle.filter((b) => b.locked).map((b) => b.label)).toEqual(["face", "hair"]);

  // A row already pointing at one attribute has nothing to narrow.
  const narrowed = rowsOf("sh3", [bind("character", "el-cass", "at-ward", "w1")], ELEMENTS);
  expect(narrowed[0].bundle).toEqual([]);
  expect(narrowed[0].attributeId).toBe("at-ward");
});

test("a changed row says what it was changed from", () => {
  /* The handoff flips the detail to "changed from plate 01". Without it a
     CHANGED badge says only that something moved, and the next question a
     person asks — from what? — has no answer on the screen. */
  const saved = [bind("background", "el-shop", "at-plate", "p1")];
  const rows = rowsOf("sh3", saved, ELEMENTS,
    { "background:0": bind("background", "el-shop", "at-plate", "p3") });
  expect(rows[1].detail).toBe("v3 of 3 plates");
  expect(rows[1].wasLine).toBe("was v1 north wall");

  // Coming off a follow, and coming off a bundle, each read as themselves.
  const fromFollow = rowsOf("sh3", [bind("background", "el-shop", "at-plate", null)], ELEMENTS,
    { "background:0": bind("background", "el-shop", "at-plate", "p2") });
  expect(fromFollow[1].wasLine).toBe("was following current");

  const fromBundle = rowsOf("sh3", [bind("character", "el-cass", null, null)], ELEMENTS,
    { "character:0": bind("character", "el-cass", "at-ward", "w1") });
  expect(fromBundle[0].wasLine).toBe("was the whole element");

  // A row with nothing pending says nothing.
  expect(rowsOf("sh3", saved, ELEMENTS)[1].wasLine).toBe("");
});

test("an empty slot offers the elements that slot can hold, and nothing else", () => {
  const none = new Set<string>();
  expect(candidatesFor("background", ELEMENTS, none).map((e) => e.name)).toEqual(["Workshop"]);
  expect(candidatesFor("element", ELEMENTS, none).map((e) => e.name)).toEqual(["The Mule"]);
  // A locked element is not offered: the lock comes off in the library.
  expect(candidatesFor("look", ELEMENTS, none)).toEqual([]);
  // Nor one already on another slot of this shot — one wire, drawn once.
  expect(candidatesFor("element", ELEMENTS, new Set(["el-mule"]))).toEqual([]);
  /* A keyframe is a frame of this shot's own take, so there is nothing in the
     library to offer and the row says so rather than sitting inert. */
  expect(candidatesFor("keyframe", ELEMENTS, none)).toEqual([]);
  expect(emptyNote("keyframe", 0)).toContain("this shot's own take");
  expect(emptyNote("background", 1)).toBe("Nothing bound. Pick one to wire it in.");
  expect(emptyNote("background", 0)).toContain("No location in this production");
});

test("a picked take is not called a draft, and one version is not 1 versions", () => {
  expect(takeLine({ version: 3, state: "picked", approved: false, seconds: null, credits: 9 }))
    .toBe("v3 · PICKED · 9 CR");
  expect(takeLine({ version: 3, state: "", approved: false, seconds: null, credits: 9 }))
    .toBe("v3 · DRAFT · 9 CR");
  // approved wins over whatever else the row says
  expect(takeLine({ version: 3, state: "picked", approved: true, seconds: null, credits: 9 }))
    .toBe("v3 · APPROVED · 9 CR");
  expect(countLine(1, "version")).toBe("1 version");
  expect(countLine(3, "version")).toBe("3 versions");
});

test("the price is stated, not offered as a button that cannot be pressed", () => {
  expect(renderPrice(40)).toBe("Rendering it again · 40 cr");
  /* Refused: the number stops being the useful fact and the reason is, so the
     line does not quote a spend that would be turned away. */
  expect(renderPrice(40, false)).toBe("Can't render yet · see above");
});
