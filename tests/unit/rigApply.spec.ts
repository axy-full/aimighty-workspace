import { test, expect } from "@playwright/test";
import { applySummary, rerenderable, rerenderBody, rerenderParams, rerenderPrompt, sendTakes } from "../../lib/rigApply";
import { getModel } from "../../lib/models";

/* The phone Rig's "Apply vN" priced shots it then skipped for having no
   words, and its last toast replaced any failure with the full cost. */
test("only shots with words to render are priced and sent", () => {
  const shots: { code: string; title: string; description: string; setup: Record<string, string | null> | null }[] = [
    { code: "SH01", title: "Wide", description: "A fox on the ice", setup: { lens: "35mm", light: null } },
    { code: "SH02", title: "", description: "", setup: {} },
    { code: "SH03", title: "Close", description: "", setup: null },
  ];
  expect(rerenderPrompt(shots[0])).toBe("A fox on the ice. 35mm");
  expect(rerenderPrompt(shots[1])).toBe("");
  expect(rerenderPrompt(shots[2])).toBe("Close");
  expect(rerenderable(shots).map((s) => s.code)).toEqual(["SH01", "SH03"]);
});

test("the summary says what started, what it costs, and what did not start", () => {
  const base = { asset: "Iver", from: "v2", to: "v3", cost: "38 cr", failure: null, skipped: 0 };
  expect(applySummary({ ...base, started: 3, sent: 3, cost: "57 cr" })).toBe("Iver → v3 · 3 takes rendering · 57 cr");
  expect(applySummary({ ...base, started: 2, sent: 3, failure: "SH05 didn't start: Not enough credits" }))
    .toBe("Iver → v3 · 2 of 3 takes rendering · 38 cr · SH05 didn't start: Not enough credits");
  expect(applySummary({ ...base, started: 0, sent: 2, cost: "0 cr", failure: "SH01 didn't start: Rate limited" }))
    .toBe("Nothing started · Iver stays on v2 · SH01 didn't start: Rate limited");
  expect(applySummary({ ...base, started: 1, sent: 1, cost: "19 cr", skipped: 2 }))
    .toBe("Iver → v3 · 1 take rendering · 19 cr · 2 shots have no words to render");
});

/* A shot planned at a length (or frame) the engine does not offer was priced
   as written, while admission bills the engine's first length: the quote sat
   under the charge and every Apply was refused against its own ceiling. */
test("a re-render is priced and sent at the settings admission will bill", () => {
  const seedance = getModel("dreamina-seedance-2-0-260128");
  expect(rerenderParams(seedance, 3)).toEqual({ ratio: "16:9", resolution: "1080p", duration: 4 });
  expect(rerenderParams(seedance, 8)).toEqual({ ratio: "16:9", resolution: "1080p", duration: 8 });
  expect(rerenderParams(seedance, null)).toEqual({ ratio: "16:9", resolution: "1080p", duration: 5 });
  expect(rerenderParams({ ratios: ["9:16"], resolutions: ["720p"], durations: [6, 10] }, 5)).toEqual({ ratio: "9:16", resolution: "720p", duration: 6 });
  expect(rerenderParams({ ratios: ["16:9"], resolutions: ["1080p"], durations: [] }, 3)).toEqual({ ratio: "16:9", resolution: "1080p", duration: 5 });
  expect(rerenderParams(null, 3)).toEqual({ ratio: "16:9", resolution: "1080p", duration: 3 });
});

test("Apply sends each quote as its ceiling and stops at the first take that does not start", async () => {
  const shots: { id: string; code: string; title: string; description: string; setup: Record<string, string | null> }[] = [
    { id: "s1", code: "SH01", title: "Wide", description: "A fox on the ice", setup: {} },
    { id: "s2", code: "SH02", title: "Close", description: "", setup: { lens: "85mm" } },
    { id: "s3", code: "SH03", title: "Out", description: "", setup: {} },
  ];
  const params = { ratio: "16:9", resolution: "1080p", duration: 5 };
  expect(rerenderBody(shots[0], { engine: "eng", projectId: "p1", params, maxCredits: 19 }))
    .toEqual({ prompt: "A fox on the ice", model: "eng", projectId: "p1", shotId: "s1", ratio: "16:9", resolution: "1080p", duration: 5, maxCredits: 19 });
  // A workspace on its own keys sends no credit ceiling.
  expect(rerenderBody(shots[1], { engine: "eng", projectId: null, params, maxCredits: null })).not.toHaveProperty("maxCredits");

  const sent: string[] = [];
  const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  const refused = await sendTakes(shots, async (s) => { sent.push(s.code); return s.code === "SH02" ? answer(409, { error: "The generation estimate changed." }) : answer(202, { id: s.id }); });
  expect(sent).toEqual(["SH01", "SH02"]);
  expect(refused.started.map((s) => s.code)).toEqual(["SH01"]);
  expect(refused.failure).toBe("SH02 didn't start: The generation estimate changed");

  // A dropped connection mid-run is reported, and what started before it still counts (so the slot still rebinds).
  const dropped = await sendTakes(shots, async (s) => { if (s.code === "SH03") throw new TypeError("Failed to fetch"); return answer(202, { id: s.id }); });
  expect(dropped.started.map((s) => s.code)).toEqual(["SH01", "SH02"]);
  expect(dropped.failure).toBe("SH03 may not have started: the connection dropped");

  const first = await sendTakes(shots, async () => { throw new TypeError("Failed to fetch"); });
  expect(first).toEqual({ started: [], failure: "SH01 may not have started: the connection dropped" });
  expect(applySummary({ asset: "Iver", from: "v2", to: "v3", started: 0, sent: 3, cost: "0 cr", failure: first.failure, skipped: 0 }))
    .toBe("Nothing started · Iver stays on v2 · SH01 may not have started: the connection dropped");
});
