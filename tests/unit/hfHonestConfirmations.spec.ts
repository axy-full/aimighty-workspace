import { test, expect } from "@playwright/test";
import { CONFIRM, boardPlace, destinationName, isHere, type Destination, type Here } from "../../lib/shell/confirmations";
import { SAY, type GenPreset } from "../../lib/shell/assets";
import { readGenPresets, sendGenPreset } from "../../lib/shell/gen-preset";
import { CAST_LIMITS, mergeAgentCast, newEntry, sourcedCastId, type CastProposal } from "../../lib/production/cast";
import { generationPhase } from "../../lib/workspace/rig";
import { SHOT_TITLE_MAX, solutionShot } from "../../lib/crew/room";

/**
 * Idea 18 — confirmations say exactly what happened and link to it. Each
 * toast's Open goes to a place that exists, that `goSuite` really shows (a
 * page id it does not know would silently land on the suite's first stage),
 * and that the toast's own words name.
 */
test("the take a toast opens is a place on the board: Shots, with that take selected", () => {
  const take = CONFIRM.take("gen_hfc_" + "a".repeat(40));
  expect(take).toEqual({ to: "page", suite: "studio", page: "takes", select: { kind: "take", id: "generation:gen_hfc_" + "a".repeat(40) } });
  expect(destinationName(take)).toBe("Shots");
  expect(boardPlace(take as Extract<Destination, { to: "page" }>)).toBe("?view=board&region=shots");
});

test("a destination that is not a place is refused rather than quietly landing on Brief", () => {
  expect(() => destinationName({ to: "page", suite: "studio", page: "frames" })).toThrow("No stage studio:frames");
  /* The phone's Home is not a place a confirmation can name. */
  expect(() => destinationName({ to: "page", suite: "studio", page: "home" })).toThrow();
  /* Nor does an unknown page become a place on the board. */
  expect(boardPlace({ to: "page", suite: "studio", page: "frames" })).toBeNull();
});

test("Open in Gen and Retry hand Gen what they carry in memory, so their toasts never rest on the browser storing it", () => {
  /* Nothing is written to storage (lib/shell/gen-preset): a Gen that opens after the toast still gets it. */
  sendGenPreset({ prompt: "Locked dawn frame", note: "Crew · solution" });
  const got: GenPreset[] = [];
  const stop = readGenPresets((p) => got.push(p));
  stop();
  expect(got).toEqual([{ prompt: "Locked dawn frame", note: "Crew · solution" }]);
});

test("a Crew solution becomes a shot named by its words before the dash, cut at a word with an ellipsis", () => {
  expect(solutionShot("Cut on the drop — hold the bottle until the beat lands")).toEqual({ title: "Cut on the drop", text: "hold the bottle until the beat lands" });
  /* No dash: the whole line names it and is its text. */
  const pinned = "24mm, camera locked, dawn coming up behind the bottle so it silhouettes then fills with light as the sun clears the sill";
  const shot = solutionShot(pinned);
  expect(shot.text).toBe(pinned);
  expect(shot.title.length).toBeLessThanOrEqual(SHOT_TITLE_MAX);
  expect(shot.title).toBe("24mm, camera locked, dawn coming up behind the bottle so it silhouettes then…");
  expect(pinned.startsWith(shot.title.slice(0, -1)), "it is the start of the words, never a cut word").toBe(true);
  expect(pinned[shot.title.length - 1]).toBe(" ");
  /* One unbroken word is cut where it must be, still marked as cut. */
  const long = solutionShot("x".repeat(120));
  expect(long.title).toBe(`${"x".repeat(SHOT_TITLE_MAX - 1)}…`);
  /* Short titles are as written; an empty one has a name. */
  expect(solutionShot("  Wide   on the water ").title).toBe("Wide on the water");
  expect(solutionShot(" — just the text").title).toBe("Crew solution");
});

test("a toast shown where its result already is carries no Open", () => {
  const at = (h: Partial<Here>): Here => ({ view: "suite", suite: "studio", page: "board", library: false, ...h });
  const brief: Destination = { to: "page", suite: "studio", page: "brief" };
  /* On the board the place is the board's own address: the Brief region. */
  expect(isHere(brief, at({ board: "?view=board&region=brief" }))).toBe(true);
  expect(isHere(brief, at({ board: "?view=board&region=cut" }))).toBe(false);
  expect(isHere(brief, at({ board: "?view=board" })), "the whole board is not the Brief region").toBe(false);
  expect(isHere(brief, at({ board: null })), "off the board, the Brief region is somewhere else").toBe(false);
  /* Gen is Make's panel, open over any page: there is where it is open. */
  expect(isHere({ to: "gen" }, at({ make: true }))).toBe(true);
  expect(isHere({ to: "gen" }, at({ view: "workspace", make: true }))).toBe(true);
  expect(isHere({ to: "gen" }, at({}))).toBe(false);
  expect(isHere({ to: "library" }, at({ library: true }))).toBe(true);
  expect(isHere({ to: "library" }, at({ library: false }))).toBe(false);
  /* Opening a particular shot or take is never "already there": the selection is the point. */
  expect(isHere({ to: "page", suite: "studio", page: "rig", select: { kind: "shot", id: "node-1" } }, at({ board: "?view=board" }))).toBe(false);
  expect(isHere({ to: "page", suite: "studio", page: "rig" }, at({ board: "?view=board" }))).toBe(true);
});

test("Cast counts what the agent's list added, not what it proposed", () => {
  const p = (name: string, kind: CastProposal["kind"] = "character"): CastProposal => ({ kind, name, description: "", prompt: `${name}, reference` });
  const cast = { entries: [newEntry("character", "Wren"), newEntry("element", "Chrome sphere")] };
  const merged = mergeAgentCast(cast, [p("Wren"), p(" wren "), p("Idris"), p("Idris"), p("Kettle", "element"), p("Chrome Sphere", "element"), p("  ")], "job-1");
  expect(merged).toMatchObject({ added: 2, known: 2, overLimit: 0 });
  expect(merged.cast.agentJobId).toBe("job-1");
  expect(merged.cast.entries.map((e) => e.name)).toEqual(["Wren", "Chrome sphere", "Idris", "Kettle"]);
  expect(merged.cast.entries[2]).toMatchObject({ kind: "character", prompt: "Idris, reference" });
  /* Each entry's id comes from the run and its name: another tab taking the same run holds it once, even renamed since. */
  expect(merged.cast.entries[2].id).toBe(sourcedCastId("job-1", "Idris"));
  const elsewhere = mergeAgentCast({ entries: [newEntry("character", "Idris Varga", "", "", {}, sourcedCastId("job-1", "Idris"))] }, [p("Idris")], "job-1");
  expect(elsewhere).toMatchObject({ added: 0, known: 1, overLimit: 0 });
  /* Seven proposals, two added: the count says two. */

  /* A full list: what does not fit is left out, and said to be. */
  const full = { entries: Array.from({ length: CAST_LIMITS.entries - 1 }, (_, i) => newEntry("element", `Prop ${i}`)) };
  const capped = mergeAgentCast(full, [p("A"), p("B"), p("C")], "job-2");
  expect(capped).toMatchObject({ added: 1, known: 0, overLimit: 2 });
  expect(capped.cast.entries).toHaveLength(CAST_LIMITS.entries);
});

test("Recreate's toasts say what reached Make, in one line, naming Make, where they land", () => {
  /* Recreate goes to Gen (lib/shell/use-asset-actions › useRecreate), so its toast carries no Open; Gen shows the recipe, and its Generate button the price. */
  expect(SAY.recreate("Fox")).toBe("Fox’s recipe is in Make.");
  expect(SAY.settingsOnly("Fox")).toBe("Fox’s model and settings are in Make.");
  for (const text of [SAY.recreate("Fox"), SAY.settingsOnly("Fox")]) {
    expect(text).toContain(destinationName({ to: "gen" }));
    expect(text).not.toMatch(/seed|quoted|price/i);
  }
});

test("a held take says why it waits — out of credits, or no free slot — never 'for approval'", () => {
  /* The Rig's own words (lib/workspace/rig). */
  expect(generationPhase({ status: "held", params: { held: { why: "credits" } } }).label).toBe("Held · needs credits");
  expect(generationPhase({ status: "held", params: { held: { why: "slots" } } }).label).toBe("Held · waiting for a slot");
  for (const why of ["credits", "slots", undefined]) {
    const phase = generationPhase({ status: "held", params: { held: { why } } });
    expect(phase.label).not.toMatch(/approval/i);
    expect(phase).toMatchObject({ tone: "blue", done: false });
  }
});
