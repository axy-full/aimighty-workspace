import { test, expect } from "@playwright/test";
import { ADAPT_WHY, MAX_LANGUAGES, languageLimit, GRID_ASPECTS, GRID_SECONDS, MANDATORIES, PACK_ROWS, cleanLanguages, deliverGrid, deliverLines, deliverName, gridSummary, nameStem } from "../../lib/v12/deliver";
import { DECK_EXPORTS, deckMeta, SHOT_COLUMNS, deckFacts, deckSections, shotListCsv, shotListTitle, shotRows, withShotEdit } from "../../lib/v12/ppm";
import { csvCell } from "../../lib/v12/csv";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";
import { stagePage } from "../../lib/v12/board/stages";
import { UNPRICED } from "../../lib/v12/unpriced";
import type { BeatSheet } from "../../lib/production/beats";

/* The Deliver stage and the PPM deck as data (lib/v12/deliver.ts, lib/v12/ppm.ts). Pure. */

test.describe("Deliver", () => {
  const cut = (over: Partial<{ aspect: string; seconds: number; complete: boolean; empty: boolean }> = {}) => ({ aspect: "16:9", seconds: 10, complete: false, empty: false, ...over });

  test("names come from the project, with the prototype's pattern", () => {
    expect(nameStem("Harbour film")).toBe("harbour-film");
    expect(nameStem("  A: B / C!  ")).toBe("a-b-c");
    expect(nameStem("???")).toBe("cut");
    expect(nameStem("x".repeat(200)).length).toBeLessThanOrEqual(60);
    expect(deliverName("harbour-film", "16:9", 30)).toBe("harbour-film_16x9_30s_v1");
    expect(deliverName("harbour-film", "4:5", 0)).toBe("harbour-film_4x5_cut_v1");
    /* What is not built is said so: no ProRes, no burned-in captions or SRT, no separate stems. */
    const lines = deliverLines("harbour-film");
    expect(lines.map((l) => l[0])).toEqual(["Naming", "Format", "Captions", "Stems"]);
    expect(lines[0][1]).toBe("harbour-film_{aspect}_{dur}_v1");
    expect(lines[1][1]).toContain("ProRes isn’t built yet");
    expect(lines[2][1]).toContain("Not built yet");
    expect(lines[3][1]).toContain("aren’t built yet");
    expect(JSON.stringify(lines)).not.toMatch(/on request|Burned-in \+ SRT|VO · Music · SFX/);
    expect(JSON.stringify(PACK_ROWS)).not.toMatch(/ProRes|SRT/);
  });

  test("the grid is four sizes by a master and three lengths; only the cut's own size can be ready, and only once it is complete", () => {
    const waiting = deliverGrid("c", cut());
    expect(waiting.map((r) => r.aspect)).toEqual([...GRID_ASPECTS]);
    expect(waiting.every((r) => r.cells.length === 1 + GRID_SECONDS.length)).toBe(true);
    expect(waiting[0].cells[0].state).toBe("waiting");
    expect(gridSummary(waiting)).toBe("0 of 16 ready");
    const done = deliverGrid("c", cut({ complete: true }));
    expect(done[0].cells[0]).toMatchObject({ state: "ready", why: null, name: "c_16x9_10s_v1" });
    expect(gridSummary(done)).toBe("1 of 16 ready");
    /* Every other cell says why it cannot be made, and none is ever ready. */
    for (const cell of done.flatMap((r) => r.cells).filter((c) => !(c.aspect === "16:9" && c.seconds === 0))) expect(cell).toMatchObject({ state: "notbuilt", why: ADAPT_WHY });
    /* A cut that is complete but empty is not ready; another size keeps its own master cell. */
    expect(deliverGrid("c", cut({ complete: true, empty: true }))[0].cells[0].state).toBe("waiting");
    expect(deliverGrid("c", cut({ aspect: "9:16", complete: true }))[1].cells[0].state).toBe("ready");
  });

  test("a thirteenth language is refused with its reason, and one read from a draft past the limit is cut to twelve", () => {
    expect(MAX_LANGUAGES).toBe(12);
    expect(languageLimit(11)).toBeNull();
    expect(languageLimit(12)).toBe("A board holds up to 12 languages. Remove one to add another.");
    const codes = ["en", "es", "fr", "de", "it", "pt", "pl", "nl", "sv", "da", "fi", "no", "cs"];
    expect(cleanLanguages(codes, () => true)).toHaveLength(12);
    expect(projectSchema.safeParse({ ...newProject("B"), boardLanguages: codes }).success).toBe(false);
    expect(projectSchema.safeParse({ ...newProject("B"), boardLanguages: codes.slice(0, 12) }).success).toBe(true);
  });

  test("languages: only known codes, once each, at most twelve", () => {
    const known = (c: string) => ["ta", "hi", "fr"].includes(c);
    expect(cleanLanguages(["ta", "ta", "xx", 3, "hi"], known)).toEqual(["ta", "hi"]);
    expect(cleanLanguages("ta", known)).toEqual([]);
    expect(cleanLanguages(Array.from({ length: 40 }, () => "ta"), known)).toEqual(["ta"]);
  });

  test("nothing priced that no route quotes: the cells' prices are 'quoted' entries, and no pack is ready", () => {
    expect(UNPRICED.adaptCut.hover).toBeTruthy();
    expect(UNPRICED.languageAdapt.hover).toBeTruthy();
    expect(PACK_ROWS.map((r) => r.platform)).toEqual(["Reels", "Shorts", "YouTube", "Meta feed"]);
    expect(PACK_ROWS.every((r) => !r.ready)).toBe(true);
    expect(MANDATORIES).toEqual(["Logo", "End packshot", "Legal line", "Fonts · colours", "VO tagline"]);
  });

  test("Film's Deliver and Pre-vis's PPM deck are pages; no other stage is", () => {
    expect(stagePage("deliver", "film")).toBe("deliver");
    expect(stagePage("ppm-deck", "previs")).toBe("ppm");
    expect(stagePage("deliver", "previs")).toBeNull();
    expect(stagePage("deliver", "campaign")).toBeNull();
    expect(stagePage("cut", "film")).toBeNull();
    expect(stagePage(null, "film")).toBeNull();
  });
});

test.describe("PPM deck and shot list", () => {
  const sheet: BeatSheet = {
    scriptSha256: "x", updatedAt: "2026-10-10T00:00:00Z",
    scenes: [
      { id: "s1", heading: "EXT. QUAY", summary: "", beats: [], characters: ["Skipper", "Deckhand"], locations: ["The quay"], props: ["Bell"], shots: [
        { id: "shot-1", description: "The harbour at first light", framing: "Wide", movement: "Held", lighting: "Low sun", sound: "Gulls", duration: 3 },
        { id: "shot-2", description: "She walks the quay", framing: "", movement: "Push", lighting: "", sound: "" },
      ] },
      { id: "s2", heading: "EXT. BOAT", summary: "", beats: [], characters: [], locations: [], props: [], shots: [{ id: "shot-3", description: "Engine catches", framing: "Close-up", movement: "", lighting: "", sound: "", duration: 2.5 }] },
    ],
  };

  test("rows start from the beat sheet, in order, with the scene's cast, places and props", () => {
    const rows = shotRows(sheet, null);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({ id: "shot-1", frame: "Wide", dur: "3 s", move: "Held", cast: "Skipper, Deckhand", location: "The quay", props: "Bell", vo: "Gulls", notes: "Low sun", lens: "", wardrobe: "" });
    expect(rows[1].frame).toBe("The harbour at first light".length > 0 ? "She walks the quay" : "");
    expect(rows[2]).toMatchObject({ dur: "2.5 s", cast: "" });
    expect(shotRows(null, null)).toEqual([]);
  });

  test("an edit is kept by the shot's own id and wins over the sheet, including an empty one", () => {
    const saved = withShotEdit(withShotEdit(null, "shot-1", "lens", " 35 mm "), "shot-1", "move", "");
    expect(saved).toEqual({ "shot-1": { lens: "35 mm", move: "" } });
    const rows = shotRows(sheet, saved);
    expect(rows[0]).toMatchObject({ lens: "35 mm", move: "", frame: "Wide" });
    /* The draft's schema takes it and refuses nonsense. */
    const project = { ...newProject("B"), boardShotList: saved, boardLanguages: ["ta"] };
    expect(projectSchema.safeParse(project).success).toBe(true);
    expect(projectSchema.safeParse({ ...project, boardShotList: { "shot-1": { colour: "red" } } }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardShotList: { "bad id!": { lens: "x" } } }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardLanguages: ["Tamil"] }).success).toBe(false);
    expect(projectSchema.safeParse({ ...project, boardShotList: { "shot-1": { lens: "x".repeat(201) } } }).success).toBe(false);
  });

  test("the title line and the CSV: eleven columns, quotes doubled, formulas quoted as text", () => {
    const rows = shotRows(sheet, withShotEdit(null, "shot-2", "notes", '=HYPERLINK("x")'));
    expect(shotListTitle(rows)).toBe("3 shots · 0:05");
    expect(shotListTitle([])).toBe("0 shots");
    expect(SHOT_COLUMNS.map((c) => c.label)).toEqual(["Shot", "Frame", "Dur", "Lens", "Camera move", "Cast", "Location", "Props", "Wardrobe", "VO / dialogue", "Notes"]);
    const lines = shotListCsv(rows).trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('"Shot","Frame","Dur","Lens","Camera move","Cast","Location","Props","Wardrobe","VO / dialogue","Notes"');
    expect(lines[2]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a "b"')).toBe('"a ""b"""');
    expect(csvCell("+1")).toBe(`"'+1"`);
  });

  test("the deck's eight sections say what the board holds, and 'none yet' where it holds nothing", () => {
    const facts = deckFacts({ script: "One two three", scriptVersions: undefined, nodes: [
      { id: "a", title: "Skipper", type: "character", refKind: "cast" }, { id: "b", title: "The quay", type: "element", refKind: "environment" },
      { id: "c", title: "Brass bell", type: "element", refKind: "element" }, { id: "d", title: "Morning light", type: "moodboard" },
    ] as never, production: { beats: sheet } as never });
    expect(facts).toMatchObject({ cast: ["Skipper"], locations: ["The quay"], props: ["Brass bell", "Bell"], looks: 1, shots: 3, wardrobe: [], scriptVersions: 1 });
    const sections = deckSections(facts, false);
    expect(sections.map((s) => s.title)).toEqual(["Cover", "Script", "Cast", "Locations", "Wardrobe and props", "Look references", "Storyboard", "Shot list"]);
    expect(sections[1].line).toBe("3 words");
    expect(sections[2].line).toBe("1 character · Skipper");
    expect(sections[6]).toMatchObject({ line: "No frames yet", empty: true });
    expect(sections[7].line).toBe("3 shots · editable table");
    expect(sections[0].line).toBe("The board’s name · the date");
    expect(deckSections(facts, true)[0].line).toBe("Your logo · the date");
    expect(deckSections(deckFacts({ script: "", scriptVersions: undefined, nodes: [], production: undefined }), false).every((s) => s.n === 1 || s.empty)).toBe(true);
  });

  test("the deck's meta counts the sections that hold something, never a fixed eight", () => {
    const empty = deckSections(deckFacts({ script: "", scriptVersions: undefined, nodes: [], production: undefined }), false);
    expect(deckMeta(empty)).toBe("Draft · 1 section");
    const some = deckSections(deckFacts({ script: "One two", scriptVersions: undefined, nodes: [{ id: "a", title: "Skipper", type: "character", refKind: "cast" }] as never, production: { beats: sheet } as never }), false);
    expect(deckMeta(some)).toBe("Draft · 6 sections");
    expect(deckMeta(some)).not.toBe("Draft · 8 sections");
  });

  test("the exports: only the shot list CSV is built, and the rest say why", () => {
    expect(DECK_EXPORTS.filter((x) => x.built).map((x) => x.id)).toEqual(["csv"]);
    for (const x of DECK_EXPORTS.filter((e) => !e.built)) expect(x.why).toBeTruthy();
  });
});
