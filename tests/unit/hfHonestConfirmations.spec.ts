import { test, expect } from "@playwright/test";
import { CONFIRM, destinationName, isHere, landingPage, openLabel, solutionStatusLabel, type Confirmation, type Destination, type Here } from "../../lib/shell/confirmations";
import { SAY, retryPreset } from "../../lib/shell/assets";
import { CAST_LIMITS, mergeAgentCast, newEntry, type CastProposal } from "../../lib/production/cast";
import { generationPhase, heldLabel } from "../../lib/workspace/rig";
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
  ["retry", CONFIRM.retry("Wide on the water")],
  ["not carried to Gen", CONFIRM.notCarried("The solution")],
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

test("Open in Gen and Retry never claim Gen holds what the browser would not store", () => {
  const missed = CONFIRM.notCarried("The solution");
  expect(missed.text).toBe("The solution could not be carried to Gen");
  expect(missed.text).not.toBe(CONFIRM.crewGen().text);
  expect(missed.open).toEqual({ to: "gen" });
  /* Retry names the take it could not carry, never "loaded". */
  expect(CONFIRM.notCarried("Wide on the water").text).toBe("Wide on the water could not be carried to Gen");
  expect(CONFIRM.notCarried("Wide on the water").text).not.toBe(CONFIRM.retry("Wide on the water").text);
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
  expect(rig.text).toBe("Added to Rig · Cut on the drop");
  expect(rig.text).not.toMatch(/board|frame/i);
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
  expect(solutionStatusLabel("boarded")).toBe("Added to Rig");
  expect(solutionStatusLabel("sent_to_brief")).toBe("Added to the Brief");
  expect(solutionStatusLabel("generated")).toBe("Opened in Gen");
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

test("Retry says what it carries — the prompt and the model — and never 'same inputs'", () => {
  expect("retry" in SAY).toBe(false);
  const retry = CONFIRM.retry("Fox");
  /* One line: Gen's note says what was carried, and its Generate button carries the price. */
  expect(retry.text).toBe("Retry · Fox loaded in Gen");
  expect(retry.text).not.toMatch(/same inputs|seed/i);
  const preset = retryPreset({ prompt: "a fox, enhanced", model: "seedance-2.5", kind: "video", params: { rawPrompt: "a fox", ratio: "16:9" }, title: "Fox" });
  expect(preset).toEqual({ prompt: "a fox", model: "seedance-2.5", type: "video", note: "Retry · Fox · same prompt and model" });
});

test("a held take says why it waits — out of credits, or no free slot — never 'for approval'", () => {
  expect(heldLabel({ params: { held: { why: "credits" } } })).toBe("Held · top up to release");
  expect(heldLabel({ params: { held: { why: "slots" } } })).toBe("Waiting for a slot");
  expect(heldLabel({})).toBe("Held · top up to release");
  expect(heldLabel(null)).toBe("Held · top up to release");
  for (const why of ["credits", "slots", undefined]) {
    const phase = generationPhase({ status: "held", params: { held: { why } } });
    expect(phase.label).not.toMatch(/approval/i);
    expect(phase).toMatchObject({ tone: "blue", done: false });
  }
});
