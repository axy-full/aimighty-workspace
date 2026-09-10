import { test, expect } from "@playwright/test";
import { csvCell } from "../../lib/csvCell";

/**
 * These exports are the handover — a producer bills a client from the shot
 * list — so the spreadsheet is opened by somebody outside the workspace, who
 * has no reason to distrust it.
 */
test("a cell that would be read as a formula is forced to text", () => {
  for (const s of ["=1+1", "+1", "-1+1", "@SUM(A1)", '=HYPERLINK("http://x","open")', "=cmd|'/c calc'!A1"]) {
    expect(csvCell(s).replace(/^"|"$/g, ""), s).toMatch(/^'/);
  }
});

test("a negative NUMBER is still a number", () => {
  /* The one column anybody sums. Quoting -12 as text would break the
     spreadsheet for the sake of a formula it was never going to be. */
  expect(csvCell(-12)).toBe("-12");
  expect(csvCell(-0.5)).toBe("-0.5");
  expect(csvCell(40)).toBe("40");
});

test("ordinary text is untouched", () => {
  expect(csvCell("SH010")).toBe("SH010");
  expect(csvCell("a boat at dawn")).toBe("a boat at dawn");
  expect(csvCell(null)).toBe("");
  expect(csvCell(undefined)).toBe("");
});

test("CSV quoting still happens, and after the guard", () => {
  expect(csvCell('the "hand-off", wide')).toBe('"the ""hand-off"", wide"');
  // Both at once: defused AND quoted.
  expect(csvCell('=A1,"x"')).toBe(`"'=A1,""x"""`);
});

test("a leading control character counts too", () => {
  for (const s of ["\tSUM", "\rSUM"]) expect(csvCell(s).replace(/^"|"$/g, "")).toMatch(/^'/);
});
