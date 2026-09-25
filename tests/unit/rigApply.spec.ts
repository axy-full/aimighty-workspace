import { test, expect } from "@playwright/test";
import { applySummary, rerenderable, rerenderPrompt } from "../../lib/rigApply";

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
