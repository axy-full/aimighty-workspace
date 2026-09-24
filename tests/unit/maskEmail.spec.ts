import { test, expect } from "@playwright/test";
import { maskEmail } from "../../lib/maskEmail";

test("an email keeps its first letters and ending, hides the rest, and gives away no length", () => {
  expect(maskEmail("axy@akshaypanchal.com")).toBe("a•••@a•••.com");
  expect(maskEmail("jaideep.lohana@zigzag.films.co.uk")).toBe("j•••@z•••.uk");
  expect(maskEmail("x@localhost")).toBe("x•••@l•••");
  for (const bad of ["", null, undefined, "no-at-sign", "@domain.com", "name@"]) expect(maskEmail(bad)).toBe("");
});
