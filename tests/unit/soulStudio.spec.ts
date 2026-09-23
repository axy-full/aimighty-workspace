import { test, expect } from "@playwright/test";
import { elementToken, parseElementCreate, parseElements } from "../../lib/higgsfield-consumer/element-parse";
import { castFromBeats, entryModel, newEntry, soulParameters } from "../../lib/production/cast";

/** Cast & Elements = Soul Studio: which Soul model builds what, only the settings a model declares, and the account's element replies. */
test("an entry's Soul model follows its kind and category; settings are only the declared ones", () => {
  expect(entryModel(newEntry("character"))).toBe("soul_cinematic");
  expect(entryModel(newEntry("element", "Harbour", "", "", { category: "environment" }))).toBe("soul_location");
  expect(entryModel(newEntry("element", "Lantern", "", "", { category: "prop" }))).toBe("soul_cinematic");
  const cinema = { parameters: [{ name: "quality", options: ["1.5k", "2k"], default: "2k" }, { name: "soul_id" }], aspectRatios: ["3:4", "16:9"], medias: [{}] };
  expect(soulParameters(cinema, { ...newEntry("character"), soulId: "soul_x", quality: "1.5k" }, "3:4")).toEqual({ quality: "1.5k", soul_id: "soul_x", aspect_ratio: "3:4" });
  expect(soulParameters(cinema, { ...newEntry("element"), soulId: "soul_x" }, "4:5")).toEqual({ quality: "2k", aspect_ratio: "3:4" });
  expect(soulParameters({ parameters: [{ name: "budget", min: 10, max: 500, default: 50 }], aspectRatios: ["16:9"], medias: [] }, { ...newEntry("character"), budget: 900 }, "3:4")).toEqual({ budget: 500, aspect_ratio: "16:9" });
  expect(soulParameters({ parameters: [], aspectRatios: [], medias: [] }, newEntry("element"), "16:9")).toEqual({});
});

test("the beat sheet's names become entries with a category; nothing already cast is added twice", () => {
  const sheet = { scriptSha256: "a".repeat(64), updatedAt: new Date().toISOString(), scenes: [
    { id: "s", heading: "H", summary: "", beats: [], shots: [], characters: ["Mara"], locations: ["Harbour"], props: ["Lantern"] },
  ] };
  const entries = castFromBeats(sheet, [newEntry("character", "mara")]);
  expect(entries.map((e) => [e.name, e.kind, e.category, entryModel(e)])).toEqual([["Harbour", "element", "environment", "soul_location"], ["Lantern", "element", "prop", "soul_cinematic"]]);
});

test("element replies are read by element_id or id, whatever the envelope; junk is not an element", () => {
  expect(parseElements({ elements: [{ element_id: "el_1", name: "Fox", category: "character" }, { id: "bad id", name: "x" }, "no"] })).toEqual([{ elementId: "el_1", name: "Fox", category: "character", previewUrl: null }]);
  expect(parseElementCreate({ element: { id: "el_2" } }, "Harbour", "environment")).toEqual({ elementId: "el_2", name: "Harbour", category: "environment", previewUrl: null });
  expect(parseElementCreate({ ok: true }, "x", null)).toBeNull();
  expect(elementToken("el_2")).toBe("<<<el_2>>>");
});
