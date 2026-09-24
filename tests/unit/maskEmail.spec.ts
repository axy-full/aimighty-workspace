import { test, expect } from "@playwright/test";
import { maskEmail } from "../../lib/maskEmail";

test("an email keeps its first letters and ending, hides the rest, and gives away no length", () => {
  expect(maskEmail("axy@akshaypanchal.com")).toBe("a•••@a•••.com");
  expect(maskEmail("jaideep.lohana@zigzag.films.co.uk")).toBe("j•••@z•••.uk");
  expect(maskEmail("x@localhost")).toBe("x•••@l•••");
  // A removed account's tag never shows, and an odd ending is hidden too.
  expect(maskEmail("jaideep@aimighty.studio#deleted-1788521023257")).toBe("j•••@a•••.studio");
  expect(maskEmail("ops@example.x-internal_1")).toBe("o•••@e•••");
  for (const bad of ["", null, undefined, "no-at-sign", "@domain.com", "name@"]) expect(maskEmail(bad)).toBe("");
});
