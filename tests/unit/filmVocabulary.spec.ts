import { test, expect } from "@playwright/test";
import {
  FILM_CHIPS, applicableSetup, chipOptions, chipValue, chipsFor, cleanSetup, composeForSend, dropToken, extraRows, hashDefault, hashToken,
  optionMatches, pickOption, recipeSetup, recoverSetup, setupLabels, vocabularyMatches, withoutSetup,
} from "../../lib/workspace/film-vocabulary";
import { composePrompt, craftModules } from "../../lib/studio";
import { INITIAL_COMPOSER, composerBlock, composerReducer } from "../../lib/workspace/composer";
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

test("a chip reads Auto until picked; picking what is held puts it back; a move and a technique that travels, or one that holds the frame, exclude each other", () => {
  const camera = chip("camera");
  expect(chipValue(camera, {})).toEqual({ text: "Auto", set: false });
  let setup = pickOption({}, camera, { row: "move", value: "push" });
  expect(setup).toEqual({ move: "push" });
  expect(chipValue(camera, setup)).toEqual({ text: "Push in", set: true });
  /* A technique that neither travels nor holds the frame rides with the move. */
  setup = pickOption(setup, camera, { row: "technique", value: "oner" });
  expect(chipValue(camera, setup).text).toBe("Push in + One-shot");
  /* Rack focus locks the camera off: it takes a move off, a move takes it off, and only Locked off rides with it. */
  expect(pickOption({ move: "push" }, camera, { row: "technique", value: "rackfocus" })).toEqual({ technique: "rackfocus" });
  expect(pickOption({ technique: "rackfocus", shot: "cu" }, camera, { row: "move", value: "crane" })).toEqual({ move: "crane", shot: "cu" });
  expect(pickOption({ move: "static" }, camera, { row: "technique", value: "rackfocus" })).toEqual({ move: "static", technique: "rackfocus" });
  expect(pickOption({ technique: "rackfocus" }, camera, { row: "move", value: "static" })).toEqual({ technique: "rackfocus", move: "static" });
  expect(chipValue(camera, { move: "static", technique: "rackfocus" }).text).toBe("Locked off + Rack focus");
  /* A technique that travels replaces the move; a move afterwards replaces that. */
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

test("the Recreate card names the take's setup and says kept only while the chips hold exactly it for this output", () => {
  const taken = { shot: "ws", move: "crane", light: "back", time: "golden" };
  /* Just recreated: the chips hold what the take carried. */
  expect(recipeSetup(taken, "video", taken, "video")).toEqual({ labels: ["Wide", "Crane", "Backlit", "Golden hour"], kept: true });
  /* A row taken off, a pick changed or one added here: changed here. */
  expect(recipeSetup(taken, "video", { shot: "ws", move: "crane", light: "back" }, "video")).toMatchObject({ kept: false, why: "Changed here" });
  expect(recipeSetup(taken, "video", { ...taken, shot: "cu" }, "video")).toMatchObject({ kept: false, why: "Changed here" });
  expect(recipeSetup(taken, "video", { ...taken, lens: "35" }, "video")).toMatchObject({ kept: false, why: "Changed here" });
  /* Gen moved to a still: the crane is not sent, and that is the reason, not a change made here. */
  expect(recipeSetup(taken, "video", taken, "image")).toEqual({ labels: ["Wide", "Crane", "Backlit", "Golden hour"], kept: false, why: "A still has no camera move" });
  expect(recipeSetup(taken, "video", { ...taken, shot: "cu" }, "image")).toMatchObject({ kept: false, why: "Changed here" });
  expect(recipeSetup(taken, "video", taken, "audio")).toMatchObject({ kept: false, why: "Sound takes no setup" });
  /* A still names what it leaves out, whatever that is. */
  expect(recipeSetup({ shot: "ws", pace: "slowmo" }, "video", { shot: "ws" }, "image")).toMatchObject({ kept: false, why: "A still has no motion" });
  expect(recipeSetup({ move: "push", technique: "oner", pace: "slowmo", sound: "silent", look: "bw" }, "video", { look: "bw" }, "image"))
    .toMatchObject({ kept: false, why: "A still has no camera move, camera technique, motion or sound" });
  /* A still's take never carried camera travel: its labels leave it out, and a still holds the rest. */
  expect(recipeSetup(taken, "image", taken, "image")).toEqual({ labels: ["Wide", "Backlit", "Golden hour"], kept: true });
  expect(recipeSetup(["cu"], "video", {}, "video")).toEqual({ labels: [], kept: true });
  expect(recipeSetup({ shot: "ws" }, "image", { shot: "ws" }, "video")).toEqual({ labels: ["Wide"], kept: true });
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
  /* What the server wrote after the words Gen sent (a move for an Auto camera, the platform's rules) comes off with the setup. */
  const inferred = craftModules({ move: "static" });
  expect(withoutSetup(`${composePrompt("a boat drifts", { shot: "cu" })}\n\n${inferred}\n\nKeep the horizon level.`, { shot: "cu" })).toBe("a boat drifts.");
  expect(withoutSetup(`${composePrompt("a boat drifts", { shot: "ws", light: "back" })}\n\nKeep the horizon level.`, { shot: "ws", light: "back" })).toBe("a boat drifts.");
  /* Words that never carried the setup keep every paragraph. */
  expect(withoutSetup("a boat drifts. Close-up at dawn.\n\nThen it rains.", { shot: "cu" })).toBe("a boat drifts. Close-up at dawn.\n\nThen it rains.");
});

test("a take that keeps no setup as data has one read back from its words, only when Gen would send exactly those words again", () => {
  const setup = { shot: "ws", angle: "low", move: "crane", technique: "oner", light: "back", look: "16mm", time: "golden", mood: "calm", pace: "slowmo" };
  const words = "harbour at dusk, a boat drifts.";
  /* Every row the bank writes comes back, and the words before it. */
  expect(recoverSetup(composePrompt(words, setup), "video")).toEqual({ setup, words });
  expect(recoverSetup(composePrompt("", { move: "push", look: "bw" }), "video")).toEqual({ setup: { move: "push", look: "bw" }, words: "" });
  expect(recoverSetup(composePrompt("a boat", { technique: "dollyzoom" }), "video")).toEqual({ setup: { technique: "dollyzoom" }, words: "a boat." });
  /* Plain words, or words the person went on writing after a setup, are left whole. */
  expect(recoverSetup("a boat drifts at dusk", "video")).toBeNull();
  expect(recoverSetup(`${composePrompt("a boat", { move: "push" })}\n\nThen it rains.`, "video")).toBeNull();
  /* A still would not send a pace: words that end with one stay as they are. */
  expect(recoverSetup(composePrompt("a boat", { shot: "cu", pace: "slowmo" }), "image")).toBeNull();
  expect(recoverSetup(composePrompt("a boat", { shot: "cu" }), "image")).toEqual({ setup: { shot: "cu" }, words: "a boat." });
  expect(recoverSetup(composePrompt("a hum", { shot: "cu" }), "audio")).toBeNull();
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
  expect(vocabularyMatches("35", "video").map((h) => `${h.chipLabel}:${h.label}`)).toEqual(["Lens:35mm", "Look:35mm film"]);
  /* Names that begin so, never a fragment inside one: a hashtag or a rank finds nothing, or only what begins with it. */
  expect(vocabularyMatches("ad", "video")).toEqual([]);
  expect(vocabularyMatches("red", "video")).toEqual([]);
  expect(vocabularyMatches("1", "video").map((h) => `${h.chipLabel}:${h.label}`)).toEqual(["Lens:14mm", "Lens:135mm", "Look:16mm"]);
  expect(vocabularyMatches("dolly", "video").map((h) => h.label)).toEqual(["Dolly zoom", "Push in", "Pull out", "Tracking"]);
  expect(vocabularyMatches("jib", "video").map((h) => h.label)).toEqual(["Crane"]);
  expect(vocabularyMatches("vertigo", "video").map((h) => h.label)).toEqual(["Dolly zoom"]);
  expect(vocabularyMatches("pan", "video").slice(0, 3).map((h) => h.label)).toEqual(["Pan", "Pan left", "Whip pan"]);
  expect(vocabularyMatches("push", "image")).toEqual([]);
  expect(vocabularyMatches("a", "video", 3)).toHaveLength(3);
  /* Enter takes the first unasked only when two letters or more begin its name: never after a bare #, a number or a hashtag. */
  const first = (q: string, type: "video" | "image" = "video") => hashDefault(q, vocabularyMatches(q, type));
  expect(first("")).toBe(-1);
  expect(first("35")).toBe(-1);
  expect(first("1")).toBe(-1);
  expect(first("p")).toBe(-1);
  expect(first("pu")).toBe(0);
  expect(first("35mm")).toBe(0);
  expect(first("dolly")).toBe(0);
  expect(first("vertigo")).toBe(0);
  expect(first("film")).toBe(-1);
  expect(first("ad")).toBe(-1);
  expect(optionMatches({ label: "Push in", aka: "dolly in", phrase: "the camera pushing slowly in" }, "dolly")).toBe(true);
  expect(optionMatches({ label: "Pan", phrase: "the camera panning across" }, "dolly")).toBe(false);
});

test("the composer holds the setup: picked, carried by a recipe (none is Auto), cleared by reset, put back by restore; the request carries it only when set", () => {
  expect(INITIAL_COMPOSER.shot).toEqual({});
  const picked = composerReducer({ ...INITIAL_COMPOSER, notice: "old" }, { type: "shot", value: { move: "push" } });
  expect(picked.shot).toEqual({ move: "push" });
  expect(picked.notice).toBeNull();
  const recreated = composerReducer(picked, { type: "recipe", value: { type: "video", picks: {}, shot: { shot: "cu" } } });
  expect(recreated.shot).toEqual({ shot: "cu" });
  expect(composerReducer(picked, { type: "recipe", value: { type: "video", picks: {} } }).shot).toEqual({});
  expect(composerReducer(picked, { type: "reset" }).shot).toEqual({});
  expect(composerReducer(recreated, { type: "restore", value: picked }).shot).toEqual({ move: "push" });

  const input = { prompt: "a boat", kind: "video" as const, model: { id: "m" }, mapping: { shotId: "s", productionProjectId: "p" }, ratio: "16:9", resolution: "720p", duration: 5, references: [] };
  expect(generationRequestBody({ ...input, shotSpec: { move: "push" } }).shotSpec).toEqual({ move: "push" });
  expect(generationRequestBody({ ...input, shotSpec: {} })).not.toHaveProperty("shotSpec");
  expect(generationRequestBody({ ...input, shotSpec: null })).not.toHaveProperty("shotSpec");
  expect(generationRequestBody(input)).not.toHaveProperty("shotSpec");
});

test("this workspace's own engines take the words however long the setup makes them: nothing blocks on the retired account's limit", () => {
  const model = { id: "dreamina-seedance-2-5-260628", label: "Seedance 2.5", type: "video" as const };
  expect(composerBlock({
    state: { type: "video", prompt: `a boat ${"x".repeat(5001)}`, voiceId: "" }, model, quote: null, quoteKey: "k", submitting: false,
    catalogue: { loading: false, error: null },
  })).toBe("Getting the live price…");
});
