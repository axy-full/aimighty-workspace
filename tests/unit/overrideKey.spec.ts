import { test, expect } from "@playwright/test";
import { rowsOf, wireKey, detailOf, type ElementIn, type BindingIn } from "../../lib/shotBindings";
import { expandPorts } from "../../lib/rig";

/* The widened binding key (SOW §9, DECIDED).
 *
 * A slot holds a bundle AND an override per attribute, and the override
 * supersedes the bundle for that attribute alone. Before this, an override
 * REPLACED the bundle: pinning a coat dropped the character's face, hair and
 * voice off the shot, and provenance recorded it that way. These tests are
 * about that sentence being true.
 */

const v = (id: string, label = "") => ({ id, label, status: "ready" });

const cass: ElementIn = {
  id: "el-cass", kind: "character", name: "Cass", locked: false, fromShotId: null,
  attributes: [
    { id: "face", kind: "face", label: "face", currentId: "f3", locked: false,
      versions: [v("f1"), v("f2"), v("f3")] },
    { id: "hair", kind: "hair", label: "hair", currentId: "h1", locked: false, versions: [v("h1")] },
    { id: "ward", kind: "wardrobe", label: "wardrobe", currentId: "w2", locked: false,
      versions: [v("w1", "waxed coat"), v("w2", "overalls")] },
  ],
};

const wire = (attributeId: string | null, versionId: string | null): BindingIn =>
  ({ slot: "character", ordinal: 0, elementId: "el-cass", attributeId, versionId });

test("a slot carries the bundle and an override at once", () => {
  const rows = rowsOf("sh3", [wire(null, null), wire("ward", "w1")], [cass]);
  const character = rows.filter((r) => r.slot === "character");

  /* ONE row, not two. The bundle is the row's identity; the override
     qualifies it. Two rows would read as two characters. */
  expect(character).toHaveLength(1);
  expect(character[0].name).toBe("Cass");

  // The shot still carries every port — that is the whole change.
  expect(character[0].detail).toBe("face v3 · hair v1 · wardrobe v1*");
  expect(character[0].badges).toContain("override");

  // And the pin is on the port it belongs to, not on the others.
  const ports = character[0].bundle;
  expect(ports.find((p) => p.label === "wardrobe")!.pinned).toBe("w1");
  expect(ports.find((p) => p.label === "wardrobe")!.at).toBe("v1");
  expect(ports.find((p) => p.label === "face")!.pinned).toBeNull();
  expect(ports.find((p) => p.label === "face")!.at).toBe("v3");
});

test("the detail line describes the shot, not the library", () => {
  // No override: every port at what the library says.
  expect(detailOf(cass, wire(null, null), "sh3")).toBe("face v3 · hair v1 · wardrobe v2");
  /* With one: the pinned port reads the shot's own version, starred. Reading
     current for all of them would describe the library, and the promise of
     the screen is that it describes the shot. */
  expect(detailOf(cass, wire(null, null), "sh3", [wire("ward", "w1")]))
    .toBe("face v3 · hair v1 · wardrobe v1*");
  // An override that follows current is not a pin and is not starred.
  expect(detailOf(cass, wire(null, null), "sh3", [wire("ward", null)]))
    .toBe("face v3 · hair v1 · wardrobe v2");
});

test("a wire's address is the row's plus the attribute", () => {
  /* Keyed by the row, a pending override overwrote the bundle's pending
     entry — the same mistake the schema used to make, one layer up. */
  expect(wireKey("character", 0, null)).toBe("character:0:");
  expect(wireKey("character", 0, "ward")).toBe("character:0:ward");
  expect(wireKey("character", 1, "ward")).not.toBe(wireKey("character", 0, "ward"));
});

test("an unsaved pin shows on the port before it is written", () => {
  const rows = rowsOf("sh3", [wire(null, null)], [cass],
    { [wireKey("character", 0, "ward")]: wire("ward", "w1") });
  const row = rows.filter((r) => r.slot === "character")[0];
  expect(row.badges).toContain("changed");
  expect(row.detail).toBe("face v3 · hair v1 · wardrobe v1*");
  expect(row.bundle.find((p) => p.label === "wardrobe")!.pinned).toBe("w1");
  /* The row's OWN wire did not move, so it has nothing to say it was changed
     from — nothing left the element. */
  expect(row.wasLine).toBe("");
});

test("re-picking what a port is already pinned to is not a change", () => {
  const rows = rowsOf("sh3", [wire(null, null), wire("ward", "w1")], [cass],
    { [wireKey("character", 0, "ward")]: wire("ward", "w1") });
  expect(rows.filter((r) => r.slot === "character")[0].badges).not.toContain("changed");
});

test("a slot bound straight to one attribute is still one row", () => {
  /* A background pinned to a plate with no bundle above it: the row IS the
     override, and its pending edit is read at that wire's address rather
     than at the bundle's — which is where the version the person just
     picked would otherwise have gone missing. */
  const shop: ElementIn = {
    id: "el-shop", kind: "location", name: "Workshop", locked: false, fromShotId: null,
    attributes: [{ id: "plate", kind: "plate", label: "plate", currentId: "p1", locked: false,
      versions: [v("p1", "north"), v("p2", "bench"), v("p3", "door")] }],
  };
  const bound: BindingIn = { slot: "background", ordinal: 0, elementId: "el-shop", attributeId: "plate", versionId: "p1" };
  const rows = rowsOf("sh3", [bound], [shop],
    { [wireKey("background", 0, "plate")]: { ...bound, versionId: "p3" } });
  const row = rows.filter((r) => r.slot === "background")[0];
  expect(row.detail).toBe("v3 of 3 plates");
  expect(row.wasLine).toBe("was v1 north");
  expect(row.badges).toContain("changed");
});

/* ── What a take was actually made from ─────────────────────────────────── */

const ATTRS: Record<string, { id: string; currentId: string | null }[]> = {
  "el-cass": [{ id: "face", currentId: "f3" }, { id: "hair", currentId: "h1" }, { id: "ward", currentId: "w2" }],
  "el-shop": [{ id: "plate", currentId: "p1" }],
  "el-bare": [{ id: "none", currentId: null }],
};
const attrsOf = (id: string) => ATTRS[id] ?? [];
const port = (elementId: string, attributeId: string | null, versionId: string | null, slot = "character", ordinal = 0) =>
  ({ elementId, attributeId, versionId, slot, ordinal });

test("a bundle becomes one port per attribute, at what the library says", () => {
  /* Recorded as itself, a bundle said nothing: one row with a null version.
     A take made through one carried no version for anything, so "make another
     from exactly this" had nothing to be exact about and every version's take
     count read zero. */
  const out = expandPorts([port("el-cass", null, null)], attrsOf);
  expect(out.map((p) => `${p.attributeId}:${p.versionId}`))
    .toEqual(["face:f3", "hair:h1", "ward:w2"]);
});

test("an override supersedes the bundle for its attribute and no other", () => {
  const out = expandPorts([port("el-cass", null, null), port("el-cass", "ward", "w1")], attrsOf);
  const byAttr = Object.fromEntries(out.map((p) => [p.attributeId, p.versionId]));
  expect(byAttr).toEqual({ face: "f3", hair: "h1", ward: "w1" });
  // Exactly one port per attribute — the bundle does not also emit a wardrobe.
  expect(out.filter((p) => p.attributeId === "ward")).toHaveLength(1);
});

test("an override on one wire does not narrow a bundle on another", () => {
  /* Two characters on one shot each keep their own pins. Keyed by element
     alone, pinning the first one's coat would have stripped the second's. */
  const out = expandPorts([
    port("el-cass", null, null, "character", 0),
    port("el-cass", "ward", "w1", "character", 0),
    port("el-cass", null, null, "character", 1),
  ], attrsOf);
  const second = out.filter((p) => p.ordinal === 1);
  expect(second.map((p) => `${p.attributeId}:${p.versionId}`))
    .toEqual(["face:f3", "hair:h1", "ward:w2"]);
});

test("an override that follows current resolves to current, not to nothing", () => {
  const out = expandPorts([port("el-shop", "plate", null, "background", 0)], attrsOf);
  expect(out).toEqual([{ elementId: "el-shop", attributeId: "plate", versionId: "p1", slot: "background", ordinal: 0 }]);
});

test("an element with nothing made for it is still cited", () => {
  /* Dropping it would be a lie in the other direction: the take really was
     rendered against an element that had no versions. */
  const out = expandPorts([port("el-bare", null, null, "element", 0)], attrsOf);
  expect(out).toEqual([{ elementId: "el-bare", attributeId: null, versionId: null, slot: "element", ordinal: 0 }]);
});
