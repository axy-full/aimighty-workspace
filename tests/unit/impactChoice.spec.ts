import { test, expect } from "@playwright/test";
import {
  isChoiceKey, headline, splitLine, primaryLabel, footnote,
  takesReturnedToDraft, spends, REASSURANCE,
} from "../../lib/impactChoice";

/* The impact panel (brief 3, surface 1b). Nothing re-renders silently: the
   panel exists to make one decision legible, and each answer carries the
   consequence a price on its own does not. */

test("the headline says what changed and how far it reaches", () => {
  expect(headline("look", 14)).toBe("You changed a look 14 shots are using.");
  expect(headline("wardrobe", 1)).toBe("You changed a wardrobe 1 shot is using.");
  // Nothing downstream is a different sentence, not the same one with a zero.
  expect(headline("plate", 0)).toBe("You changed a plate nothing has been rendered with yet.");
});

test("the line under it answers the question actually being asked", () => {
  expect(REASSURANCE).toContain("Nothing has been re-rendered yet");
});

test("the split drops whichever side is nothing", () => {
  expect(splitLine(6, 8)).toBe("6 approved · 8 draft");
  expect(splitLine(6, 0)).toBe("6 approved");
  expect(splitLine(0, 8)).toBe("8 draft");
  expect(splitLine(0, 0)).toBe("");
});

/* Leaving takes alone is not a re-render, so the button does not read like
   one — the design changes the label for that choice alone. */
test("the button reads as what it does", () => {
  expect(primaryLabel("all", "Re-render all 14")).toBe("Re-render all 14");
  expect(primaryLabel("approved", "Re-render approved only")).toBe("Re-render approved only");
  expect(primaryLabel("none", "Leave existing takes")).toBe("Keep existing takes");
});

/* The footnote restates the consequence in numbers. The reference puts a
   dollar figure here; the product speaks credits everywhere but the top-up
   screen, so it says what the choice LEAVES BEHIND instead. */
test("the footnote says what the choice leaves behind, in credits", () => {
  const at = { credits: 406, approved: 6, draft: 8, version: "v3" };
  expect(footnote("all", at)).toBe("406 CR · 6 APPROVALS TO REDO");
  expect(footnote("approved", { ...at, credits: 174 })).toBe("174 CR · 8 DRAFTS LEFT ON V3");
  expect(footnote("none", { ...at, credits: 0 })).toBe("NOTHING RE-RENDERS · 14 SHOTS STAY ON V3");
  // No dollars anywhere in any of them.
  for (const k of ["all", "approved", "none"] as const) expect(footnote(k, at)).not.toContain("$");
});

test("the footnote stays true when a side is empty", () => {
  expect(footnote("all", { credits: 58, approved: 0, draft: 2, version: "v1" })).toBe("58 CR · NOTHING TO RE-APPROVE");
  expect(footnote("approved", { credits: 29, approved: 1, draft: 0, version: "v1" })).toBe("29 CR · NO DRAFTS TO LEAVE BEHIND");
  expect(footnote("none", { credits: 0, approved: 0, draft: 0, version: "v1" })).toBe("NOTHING RE-RENDERS");
  // Singulars read as singulars.
  expect(footnote("all", { credits: 29, approved: 1, draft: 0, version: "v1" })).toContain("1 APPROVAL TO REDO");
  expect(footnote("approved", { credits: 29, approved: 1, draft: 1, version: "v2" })).toContain("1 DRAFT LEFT ON V2");
});

/* A take approved against the old version no longer shows what the shot is,
   so re-rendering sends it back to be approved again. A draft was never
   signed off, so nothing about it changes. */
test("only the approved takes are sent back, and only when something re-renders", () => {
  expect(takesReturnedToDraft("all")).toBe("all-approved");
  expect(takesReturnedToDraft("approved")).toBe("all-approved");
  expect(takesReturnedToDraft("none")).toBe("none");

  expect(spends("all")).toBe(true);
  expect(spends("approved")).toBe(true);
  expect(spends("none")).toBe(false);
});

test("only the three answers are answers", () => {
  expect(isChoiceKey("all")).toBe(true);
  expect(isChoiceKey("approved")).toBe(true);
  expect(isChoiceKey("none")).toBe(true);
  expect(isChoiceKey("leave")).toBe(false);
  expect(isChoiceKey("")).toBe(false);
  expect(isChoiceKey(null)).toBe(false);
});
