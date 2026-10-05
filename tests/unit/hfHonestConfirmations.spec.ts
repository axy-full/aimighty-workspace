import { test, expect } from "@playwright/test";
import { CONFIRM, destinationName, isHere, landingPage, openLabel, solutionStatusLabel, type Confirmation, type Destination, type Here } from "../../lib/shell/confirmations";
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
const EVERY: [string, Confirmation][] = [
  ["crew → Brief", CONFIRM.crewBrief()],
  ["crew → Rig", CONFIRM.crewRig("Cut on the drop", "node-1")],
  ["crew → Rig, no node named", CONFIRM.crewRig("Cut on the drop")],
  ["crew → Gen", CONFIRM.crewGen()],
  ["minutes filed", CONFIRM.minutesFiled()],
  ["cast taken", CONFIRM.castTaken({ added: 3, known: 2, overLimit: 0 })],
  ["cast taken, nothing new", CONFIRM.castTaken({ added: 0, known: 4, overLimit: 0 })],
  ["cast built · character", CONFIRM.castBuilt("Mira", "character")],
  ["cast built · element", CONFIRM.castBuilt("Chrome sphere", "element")],
  ["plate built", CONFIRM.plateBuilt("Harbour at dawn")],
  ["plate built, unnamed", CONFIRM.plateBuilt("")],
  ["breakdown to Rig", CONFIRM.breakdownToRig()],
  ["scene nodes to Rig", CONFIRM.breakdownToRig(4)],
];

test("every confirmation opens a real place, the one its words name, under that place's own label", () => {
  for (const [name, c] of EVERY) {
    expect(c.open, name).toBeTruthy();
    const to = c.open!;
    const place = destinationName(to);
    expect(c.text, `${name} names where it opens`).toContain(place);
    expect(openLabel(to), name).toBe(`Open ${place}`);
    if (to.to === "page") {
      const landed = landingPage(to);
      expect(landed.id, `${name} lands on the page it asks for`).toBe(to.page);
      expect(landed.label, name).toBe(place);
      expect(landed.phoneOnly ?? false, name).toBe(false);
    }
  }
  /* The take Business opens is a stage too: Takes, with that take selected. */
  const take = CONFIRM.take("gen_hfc_" + "a".repeat(40));
  expect(take).toEqual({ to: "page", suite: "studio", page: "takes", select: { kind: "take", id: "generation:gen_hfc_" + "a".repeat(40) } });
  expect(destinationName(take)).toBe("Takes");
  expect(landingPage(take as Extract<Destination, { to: "page" }>).id).toBe("takes");
});

test("a destination that is not a stage is refused rather than quietly landing on Brief", () => {
  expect(() => destinationName({ to: "page", suite: "studio", page: "frames" })).toThrow("No stage studio:frames");
  /* The phone's Home is not a place a confirmation can name. */
  expect(() => destinationName({ to: "page", suite: "studio", page: "home" })).toThrow();
  /* …which is exactly what goSuite would otherwise have done with it. */
  expect(landingPage({ to: "page", suite: "studio", page: "frames" }).id).toBe("brief");
});

test("Open in Gen and Retry hand Gen what they carry in memory, so their toasts never rest on the browser storing it", () => {
  /* Nothing is written to storage (lib/shell/gen-preset): a Gen that opens after the toast still gets it. */
  sendGenPreset({ prompt: "Locked dawn frame", note: "Crew · solution" });
  const got: GenPreset[] = [];
  const stop = readGenPresets((p) => got.push(p));
  stop();
  expect(got).toEqual([{ prompt: "Locked dawn frame", note: "Crew · solution" }]);
  expect(CONFIRM.crewGen().text).toBe("The solution is Make’s prompt");
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

test("Crew › → Rig says Rig and opens that shot; it never claims a Storyboards frame", () => {
  const rig = CONFIRM.crewRig("Cut on the drop", "node-abc");
  expect(rig.text).toBe("Added to the Board · Cut on the drop");
  expect(rig.text).not.toMatch(/storyboard|frame/i);
  expect(rig.open).toEqual({ to: "page", suite: "studio", page: "rig", select: { kind: "shot", id: "node-abc" } });
  expect(CONFIRM.crewRig("Cut on the drop").open).toEqual({ to: "page", suite: "studio", page: "rig" });
  /* Open in Gen: Gen fills its prompt, so nothing is said about pasting or copying. */
  expect(CONFIRM.crewGen().text).not.toMatch(/paste|copied|clipboard/i);
  expect(CONFIRM.crewGen().open).toEqual({ to: "gen" });
});

test("a solution's line names the same place its route's confirmation opens", () => {
  expect(solutionStatusLabel("open")).toBeNull();
  const routes: ["sent_to_brief" | "boarded" | "generated", Confirmation][] = [["sent_to_brief", CONFIRM.crewBrief()], ["boarded", CONFIRM.crewRig("x")], ["generated", CONFIRM.crewGen()]];
  for (const [status, c] of routes) expect(solutionStatusLabel(status), status).toContain(destinationName(c.open!));
  expect(solutionStatusLabel("boarded")).toBe("Added to the Board");
  expect(solutionStatusLabel("sent_to_brief")).toBe("Added to the Brief");
  expect(solutionStatusLabel("generated")).toBe("Opened in Make");
});

test("a toast shown where its result already is carries no Open", () => {
  const at = (h: Partial<Here>): Here => ({ view: "suite", suite: "studio", page: "cast", library: false, ...h });
  const cast = CONFIRM.castTaken({ added: 1, known: 0, overLimit: 0 }).open!;
  expect(isHere(cast, at({}))).toBe(true);
  expect(isHere(cast, at({ page: "rig" }))).toBe(false);
  expect(isHere(cast, at({ view: "crew" })), "Crew's view is not the Cast stage").toBe(false);
  expect(isHere({ to: "gen" }, at({ view: "gen" }))).toBe(true);
  expect(isHere({ to: "gen" }, at({}))).toBe(false);
  expect(isHere({ to: "library" }, at({ library: true }))).toBe(true);
  expect(isHere({ to: "library" }, at({ library: false }))).toBe(false);
  /* Opening a particular shot or take is never "already there": the selection is the point. */
  expect(isHere(CONFIRM.crewRig("x", "node-1").open!, at({ page: "rig" }))).toBe(false);
  expect(isHere(CONFIRM.crewRig("x").open!, at({ page: "rig" }))).toBe(true);
});

test("Cast counts what the agent's list added, not what it proposed", () => {
  const p = (name: string, kind: CastProposal["kind"] = "character"): CastProposal => ({ kind, name, description: "", prompt: `${name}, reference` });
  const cast = { entries: [newEntry("character", "Mira"), newEntry("element", "Chrome sphere")] };
  const merged = mergeAgentCast(cast, [p("Mira"), p(" mira "), p("Idris"), p("Idris"), p("Kettle", "element"), p("Chrome Sphere", "element"), p("  ")], "job-1");
  expect(merged).toMatchObject({ added: 2, known: 2, overLimit: 0 });
  expect(merged.cast.agentJobId).toBe("job-1");
  expect(merged.cast.entries.map((e) => e.name)).toEqual(["Mira", "Chrome sphere", "Idris", "Kettle"]);
  expect(merged.cast.entries[2]).toMatchObject({ kind: "character", prompt: "Idris, reference" });
  /* Each entry's id comes from the run and its name: another tab taking the same run holds it once, even renamed since. */
  expect(merged.cast.entries[2].id).toBe(sourcedCastId("job-1", "Idris"));
  const elsewhere = mergeAgentCast({ entries: [newEntry("character", "Idris Varga", "", "", {}, sourcedCastId("job-1", "Idris"))] }, [p("Idris")], "job-1");
  expect(elsewhere).toMatchObject({ added: 0, known: 1, overLimit: 0 });
  /* Seven proposals, two added: the toast says two. */
  expect(CONFIRM.castTaken(merged).text).toBe("The agent added 2 entries to Cast · 2 already listed");
  expect(CONFIRM.castTaken({ added: 1, known: 0, overLimit: 0 }).text).toBe("The agent added 1 entry to Cast");
  expect(CONFIRM.castTaken({ added: 0, known: 3, overLimit: 0 }).text).toBe("The agent added nothing new to Cast · 3 already listed");

  /* A full list: what does not fit is left out, and said to be. */
  const full = { entries: Array.from({ length: CAST_LIMITS.entries - 1 }, (_, i) => newEntry("element", `Prop ${i}`)) };
  const capped = mergeAgentCast(full, [p("A"), p("B"), p("C")], "job-2");
  expect(capped).toMatchObject({ added: 1, known: 0, overLimit: 2 });
  expect(capped.cast.entries).toHaveLength(CAST_LIMITS.entries);
  expect(CONFIRM.castTaken(capped).text).toBe("The agent added 1 entry to Cast · 2 left out · the list is full");
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
