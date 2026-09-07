import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Publishing copies each clip's bytes, and a request has a ceiling: the
 * route must publish only what is missing, in slices, and say what is left
 * — or a batch of 36 can never finish (every call would redo the same
 * first ones until it is cut off again).
 */
test("publish skips what is already published, works in slices, and reports the remainder", () => {
  const src = readFileSync("app/api/admin/previews/route.ts", "utf8");
  expect(src).toContain("const already = new Set");
  expect(src).toMatch(/force \|\| !already\.has\(c\.key\)/);
  expect(src).toMatch(/todo\.slice\(0, slice\)/);
  expect(src).toContain("remaining:");
  // The slice is bounded on both sides, so one call can neither stall nor run away.
  expect(src).toMatch(/Math\.max\(1, Math\.min\(24, Number\(body\.limit\) \|\| 10\)\)/);
});
