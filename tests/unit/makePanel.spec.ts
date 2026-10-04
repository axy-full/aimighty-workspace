import { test, expect } from "@playwright/test";
import { fromGenLink, readMake } from "../../lib/shell/make";
import { EMPTY_PROMPT, composerBlock, composerButtonLabel, composerButtonParts, INITIAL_COMPOSER } from "../../lib/workspace/composer";

/* Make (design/particl-graphite/README.md § 1.1, § 1.2, § 3.2): its address, and every old Gen address landing on it. */

test("make= names a type, Recent, or the last type; anything else is closed", () => {
  expect(readMake("?make=video")).toBe("video");
  expect(readMake("?make=image")).toBe("image");
  expect(readMake("?make=audio")).toBe("audio");
  expect(readMake("?make=recent")).toBe("recent");
  expect(readMake("?make=1")).toBe("last");
  /* States of the panel, never addresses. */
  for (const state of ["change", "fill", "made", "images", ""]) expect(readMake(`?make=${state}`), state).toBeNull();
  expect(readMake("?view=board")).toBeNull();
});

test("the old Gen page lands on the same address with Make open on its type, and nothing else in the query is lost", () => {
  expect(fromGenLink("?view=gen")).toBe("make=video");
  expect(fromGenLink("?view=gen&mode=video")).toBe("make=video");
  expect(fromGenLink("?view=gen&mode=images")).toBe("make=image");
  expect(fromGenLink("?view=gen&mode=audio")).toBe("make=audio");
  expect(fromGenLink("?view=gen&sheet=1")).toBe("make=video");
  expect(fromGenLink("?view=gen&mode=images&sheet=1&project=p1")).toBe("project=p1&make=image");
  /* The page under it is whatever the rest of the query names (Studio when it names none). */
  expect(fromGenLink("?project=p1&suite=particl&page=takes&sp=takes&view=gen")).toBe("project=p1&suite=particl&page=takes&sp=takes&make=video");
  /* A make= already there wins over mode=. */
  expect(fromGenLink("?view=gen&mode=audio&make=recent")).toBe("make=recent");
  /* Not a Gen link: nothing to move. */
  expect(fromGenLink("?view=crew&cp=room")).toBeNull();
  expect(fromGenLink("?make=video")).toBeNull();
  expect(fromGenLink("")).toBeNull();
});

test("Make's button says Make at the same live price; only the verb changes", () => {
  const quote = { key: "k", credits: 43, state: "ready" as const, reason: null };
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false, verb: "Make" })).toBe("Make · 43 cr");
  expect(composerButtonParts({ quote, quoteKey: "k", submitting: false, count: 3, verb: "Make" })).toEqual({ action: "Make 3 takes", price: "129 cr" });
  expect(composerButtonParts({ quote, quoteKey: "k", submitting: false, draft: true, verb: "Make" }).action).toBe("Make draft");
  expect(composerButtonLabel({ quote: { ...quote, approximate: true }, quoteKey: "k", submitting: false, verb: "Make" })).toBe("Make · about 43 cr");
  /* Every other composer still says Generate. */
  expect(composerButtonLabel({ quote, quoteKey: "k", submitting: false })).toBe("Generate · 43 cr");
  /* The empty prompt's reason is one constant, so Make can say it in its own words. */
  const model = { id: "m", label: "M", type: "video" as const } as Parameters<typeof composerBlock>[0]["model"];
  expect(composerBlock({ state: { ...INITIAL_COMPOSER, prompt: " " }, model, quote, quoteKey: "k", submitting: false, catalogue: { loading: false, error: null } })).toBe(EMPTY_PROMPT);
});
