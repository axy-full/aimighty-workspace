import { test, expect } from "@playwright/test";
import {
  FILM_CHIPS, applicableSetup, chipOptions, chipValue, chipsFor, cleanSetup, composeForSend, dropToken, extraRows, hashToken,
  optionMatches, pickOption, setupLabels, vocabularyMatches, withoutSetup,
} from "../../lib/workspace/film-vocabulary";
import { composePrompt } from "../../lib/studio";
import { INITIAL_COMPOSER, composerReducer } from "../../lib/workspace/composer";
import { generationRequestBody } from "../../lib/workbench/generation-request";

/**
 * Gen's film vocabulary (idea 13): the camera bank as six chips, `#` in the
 * words, the setup written into the words once and sent as data, and taken
 * back out of the words when a take is recreated. Pure; nothing runs.
 */
const chip = (key: string) => FILM_CHIPS.find((c) => c.key === key)!;

test("six chips on video, five on a still (no camera travel), none on sound; Camera offers the moves then the named techniques, with their loops", () => {
  expect(chipsFor("video").map((c) => c.label)).toEqual(["Shot", "Angle", "Camera", "Lens", "Light", "Look"]);
  expect(chipsFor("image").map((c) => c.label)).toEqual(["Shot", "Angle", "Lens", "Light", "Look"]);
  expect(chipsFor("audio")).toEqual([]);
  const camera = chipOptions(chip("camera"));
  expect(camera[0]).toMatchObject({ row: "move", value: "static", label: "Locked off", previewKey: "move:static" });
  expect(camera.find((o) => o.value === "push")).toMatchObject({ label: "Push in", aka: "dolly in", previewKey: "move:push" });
  expect(camera.at(-1)?.row).toBe("technique");
  expect(camera.findIndex((o) => o.row === "technique")).toBeGreaterThan(camera.findLastIndex((o) => o.row === "move"));
  /* Loops exist for moves and techniques only; framing, lens, light and look are drawn. */
  expect(chipOptions(chip("shot")).every((o) => o.previewKey === null)).toBe(true);
  expect(chipOptions(chip("look")).map((o) => o.label)).toContain("Bleach bypass");
});

test("a chip reads Auto until picked; picking what is held puts it back; a travelling technique and a move exclude each other", () => {
  const camera = chip("camera");
  expect(chipValue(camera, {})).toEqual({ text: "Auto", set: false });
  let setup = pickOption({}, camera, { row: "move", value: "push" });
  expect(setup).toEqual({ move: "push" });
  expect(chipValue(camera, setup)).toEqual({ text: "Push in", set: true });
  /* A technique that does not travel rides with the move. */
  setup = pickOption(setup, camera, { row: "technique", value: "rackfocus" });
  expect(chipValue(camera, setup).text).toBe("Push in + Rack focus");
  /* One that travels replaces it; a move afterwards replaces that. */
  setup = pickOption(setup, camera, { row: "technique", value: "dollyzoom" });
  expect(setup).toEqual({ technique: "dollyzoom" });
  expect(chipValue(camera, { move: "push", technique: "dollyzoom" }).text).toBe("Dolly zoom");
  setup = pickOption(setup, camera, { row: "move", value: "orbit" });
  expect(setup).toEqual({ move: "orbit" });
  /* The same pick again is Auto for that row; Auto clears the whole chip. */
  expect(pickOption({ move: "orbit", shot: "cu" }, camera, { row: "move", value: "orbit" })).toEqual({ shot: "cu" });
  expect(pickOption({ move: "orbit", technique: "oner", lens: "35" }, camera, null)).toEqual({ lens: "35" });
  expect(chipValue(chip("lens"), { lens: "anamorphic" })).toEqual({ text: "Anamorphic", set: true });
});

test("a still uses framing, lens, light, hour, look and mood; rows no chip shows are listed by name; a setup from anywhere is cleaned", () => {
  const setup = { shot: "cu", move: "push", technique: "fpv", pace: "slowmo", sound: "silent", time: "golden", mood: "calm", custom: "x" };
  expect(applicableSetup(setup, "image")).toEqual({ shot: "cu", time: "golden", mood: "calm", custom: "x" });
  expect(applicableSetup(setup, "audio")).toEqual({});
  expect(applicableSetup(setup, "video")).toEqual(setup);
  expect(extraRows(setup, "image")).toEqual([
    { row: "time", label: "Time of day", value: "Golden hour" },
    { row: "mood", label: "Mood", value: "Calm" },
    { row: "custom", label: "custom", value: "x" },
  ]);
  expect(extraRows({ move: "push", pace: "slowmo" }, "video")).toEqual([{ row: "pace", label: "Motion", value: "Slow motion" }]);
  expect(cleanSetup({ shot: "cu", n: 3, empty: "", list: ["a"] })).toEqual({ shot: "cu" });
  expect(cleanSetup(["cu"])).toEqual({});
  expect(Object.keys(cleanSetup(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "v"]))))).toHaveLength(20);
  expect(setupLabels({ shot: "ws", move: "crane", light: "back", time: "golden" })).toEqual(["Wide", "Crane", "Backlit", "Golden hour"]);
});

test("Generate sends the words with the setup written in once, the bank's way, and the setup as data; a still never gets a camera module", () => {
  expect(composeForSend("a boat", {}, "video")).toEqual({ prompt: "a boat", shotSpec: null });
  const video = composeForSend("a boat drifts", { shot: "ws", move: "crane", light: "back" }, "video");
  expect(video.prompt).toBe(composePrompt("a boat drifts", { shot: "ws", move: "crane", light: "back" }));
  expect(video.prompt).toMatch(/^a boat drifts\. Wide shot\.\n\nThe camera rises vertically on a jib/);
  expect(video.shotSpec).toEqual({ shot: "ws", move: "crane", light: "back" });
  expect(composeForSend(video.prompt, video.shotSpec!, "video").prompt).toBe(video.prompt);
  const still = composeForSend("a boat", { shot: "cu", move: "push", look: "bw" }, "image");
  expect(still.shotSpec).toEqual({ shot: "cu", look: "bw" });
  expect(still.prompt).not.toMatch(/camera travels/);
  expect(still.prompt).toMatch(/^a boat\. Close-up\.\n\nBlack and white/);
  expect(composeForSend("a hum", { shot: "cu" }, "audio")).toEqual({ prompt: "a hum", shotSpec: null });
  /* raw: keeps its prefix, so the words and the setup go exactly as written. */
  expect(composeForSend("raw: a boat", { shot: "cu" }, "video").prompt).toBe("raw: a boat. Close-up.");
});

test("a recreated take's words come back without the setup written into them, and only an intact setup is taken out", () => {
  const setups: Record<string, string>[] = [{ shot: "cu" }, { move: "push" }, { shot: "ws", move: "crane", light: "back", time: "golden", look: "16mm" }, { technique: "dollyzoom", lens: "85" }];
  for (const setup of setups) {
    for (const words of ["harbour at dusk, a boat drifts.", "harbour at dusk, @Image1 walks the pier."]) {
      expect(withoutSetup(composePrompt(words, setup), setup)).toBe(words);
    }
    expect(withoutSetup(composePrompt("", setup), setup)).toBe("");
  }
  const written = composePrompt("a boat", { move: "push" });
  expect(withoutSetup(`${written} Then it rains.`, { move: "push" })).toBe(`${written} Then it rains.`);
  expect(withoutSetup("a boat, no setup here", { shot: "cu" })).toBe("a boat, no setup here");
  expect(withoutSetup("a boat", { custom: "x" })).toBe("a boat");
});

test("# opens a word, not the one in C#; the #word leaves the words cleanly; the bank is searched by name, other name and phrase", () => {
  expect(hashToken("a boat #pu", 10)).toEqual({ start: 7, end: 10, query: "pu" });
  expect(hashToken("#", 1)).toEqual({ start: 0, end: 1, query: "" });
  expect(hashToken("#push now", 3)).toEqual({ start: 0, end: 5, query: "push" });
  expect(hashToken("in C#", 5)).toBeNull();
  expect(hashToken("a #push now", 11)).toBeNull();
  expect(hashToken("(#Orb", 5)).toEqual({ start: 1, end: 5, query: "orb" });
  expect(dropToken("a boat #pu", { start: 7, end: 10, query: "pu" })).toEqual({ text: "a boat", caret: 6 });
  expect(dropToken("a #pu boat", { start: 2, end: 5, query: "pu" })).toEqual({ text: "a boat", caret: 2 });
  expect(dropToken("#pu a boat", { start: 0, end: 3, query: "pu" })).toEqual({ text: "a boat", caret: 0 });
  expect(dropToken("a boat #pu, then", { start: 7, end: 10, query: "pu" })).toEqual({ text: "a boat, then", caret: 6 });

  expect(vocabularyMatches("", "video")[0]).toMatchObject({ chip: "camera", label: "Locked off" });
  expect(vocabularyMatches("", "image")[0]).toMatchObject({ chip: "shot", label: "Extreme close" });
  expect(vocabularyMatches("35", "video").map((h) => `${h.chipLabel}:${h.label}`)).toEqual(["Lens:35mm", "Look:35mm film", "Lens:135mm"]);
  expect(vocabularyMatches("dolly", "video").map((h) => h.label)).toEqual(["Dolly zoom", "Push in", "Pull out"]);
  expect(vocabularyMatches("vertigo", "video").map((h) => h.label)).toEqual(["Dolly zoom"]);
  expect(vocabularyMatches("pan", "video").slice(0, 3).map((h) => h.label)).toEqual(["Pan", "Pan left", "Whip pan"]);
  expect(vocabularyMatches("push", "image")).toEqual([]);
  expect(vocabularyMatches("a", "video", 3)).toHaveLength(3);
  expect(optionMatches({ label: "Push in", aka: "dolly in", phrase: "the camera pushing slowly in" }, "dolly")).toBe(true);
  expect(optionMatches({ label: "Pan", phrase: "the camera panning across" }, "dolly")).toBe(false);
});

test("the composer holds the setup: picked, carried by a recipe (none is Auto), cleared by reset, put back by restore; the request carries it only when set", () => {
  expect(INITIAL_COMPOSER.shot).toEqual({});
  const picked = composerReducer({ ...INITIAL_COMPOSER, notice: "old" }, { type: "shot", value: { move: "push" } });
  expect(picked.shot).toEqual({ move: "push" });
  expect(picked.notice).toBeNull();
  const recreated = composerReducer(picked, { type: "recipe", value: { type: "video", billing: "workspace", picks: {}, shot: { shot: "cu" } } });
  expect(recreated.shot).toEqual({ shot: "cu" });
  expect(composerReducer(picked, { type: "recipe", value: { type: "video", billing: "workspace", picks: {} } }).shot).toEqual({});
  expect(composerReducer(picked, { type: "reset" }).shot).toEqual({});
  expect(composerReducer(recreated, { type: "restore", value: picked }).shot).toEqual({ move: "push" });

  const input = { prompt: "a boat", kind: "video" as const, model: { id: "m" }, mapping: { shotId: "s", productionProjectId: "p" }, ratio: "16:9", resolution: "720p", duration: 5, references: [] };
  expect(generationRequestBody({ ...input, shotSpec: { move: "push" } }).shotSpec).toEqual({ move: "push" });
  expect(generationRequestBody({ ...input, shotSpec: {} })).not.toHaveProperty("shotSpec");
  expect(generationRequestBody({ ...input, shotSpec: null })).not.toHaveProperty("shotSpec");
  expect(generationRequestBody(input)).not.toHaveProperty("shotSpec");
});
