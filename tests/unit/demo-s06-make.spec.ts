import { test, expect } from "@playwright/test";
import { RECENT_CHIPS, inferType, makeDest, readMake, recentEntries, typeNote, wantsChange } from "../../lib/shell/make";

/* Make with the new interface (design/particl-graphite/README.md § 3.2, "Make frames.dc.html"): Auto's type, the line
   that says where a result goes, `make=change`, and Recent's chips. */

test("Auto infers the type from the words, as the master does: a still, a sound, else video", () => {
  expect(inferType("make shot 2 at golden hour")).toBe("video");
  expect(inferType("a still of the sphere at blue hour")).toBe("image");
  expect(inferType("Poster for the launch")).toBe("image");
  expect(inferType("key art for the series")).toBe("image");
  expect(inferType("her line, a calm voice")).toBe("audio");
  expect(inferType("music under the walk")).toBe("audio");
  /* Whole words only: "lineup" is not a line, "framework" is not a frame. */
  expect(inferType("the lineup walks in")).toBe("video");
  expect(inferType("a framework of light")).toBe("video");
  /* No words: the type stays as it is. */
  expect(inferType("")).toBeNull();
  expect(inferType("   ")).toBeNull();
});

test("Auto never turns to sound while references are attached: sound takes none, so they would be dropped", () => {
  expect(inferType("her line, a calm voice", { references: 2 })).toBe("video");
  expect(inferType("a still with music in mind", { references: 1 })).toBe("image");
  expect(inferType("her line, a calm voice", { references: 0 })).toBe("audio");
});

test("the note beside the type says how it was chosen, and goes once the person picks", () => {
  expect(typeNote("", false)).toBe("inferred from your words");
  expect(typeNote("make shot 2", false)).toBe("from your words");
  expect(typeNote("make shot 2", true)).toBeNull();
  expect(typeNote("", true)).toBeNull();
});

test("where a result goes: the project's Library, and the board when one is open", () => {
  expect(makeDest("Spring film", false)).toBe("To Spring film · Library");
  expect(makeDest("Spring film", true)).toBe("To Spring film · Library and the board");
  expect(makeDest(null, false)).toBe("To a new project · Library");
  expect(makeDest("  ", true)).toBe("To a new project · Library and the board");
});

test("make=change opens Make on the last type with its engine list open; nothing else asks for the list", () => {
  expect(readMake("?make=change")).toBe("last");
  expect(wantsChange("?make=change")).toBe(true);
  expect(wantsChange(new URLSearchParams("view=board&make=change"))).toBe(true);
  for (const q of ["?make=1", "?make=video", "?make=recent", "?change=1", ""]) expect(wantsChange(q), q).toBe(false);
});

test("Recent's chips are the master's: All, Takes, Unfiled, Filed", () => {
  expect([...RECENT_CHIPS]).toEqual(["All", "Takes", "Unfiled", "Filed"]);
  const take = (id: string, shotId: string | null) => ({ take: { kind: "GEN" as const, id }, asset: { origin: "generation" as const, value: { shotId } } });
  const upload = (id: string) => ({ take: { kind: "UPLOAD" as const, id }, asset: { origin: "upload" as const, value: { filename: `${id}.jpg` } } });
  /* The Library's order, newest first. */
  const items = [take("t3", "shot-a"), upload("u2"), take("t2", null), take("t1", "shot-b"), upload("u1")];
  const ids = (chip: (typeof RECENT_CHIPS)[number]) => recentEntries(items, chip).map((e) => e.take.id);
  expect(ids("All")).toEqual(["t3", "u2", "t2", "t1", "u1"]);
  expect(ids("Takes")).toEqual(["t3", "t2", "t1"]);
  expect(ids("Unfiled")).toEqual(["t2"]);
  expect(ids("Filed")).toEqual(["t3", "t1"]);
  /* A take with no shot field at all reads as unfiled, never filed. */
  expect(recentEntries([{ take: { kind: "GEN" as const, id: "t0" }, asset: { origin: "generation" as const, value: {} } }], "Unfiled")).toHaveLength(1);
});
