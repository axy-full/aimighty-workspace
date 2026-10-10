import { test, expect } from "@playwright/test";
import { joinReturnOf, readJoinReturn } from "../../lib/v12/joinReturn";

/* After joining, back where they were (lib/v12/joinReturn.ts): the visitor's Make or Home, read once, kept a few hours. */
test("where the visitor was, from the page's address: Make, else Home", () => {
  expect(joinReturnOf("/?guest=1&view=make")).toBe("make");
  expect(joinReturnOf("/?guest=1")).toBe("home");
  expect(joinReturnOf("/?guest=1&view=board")).toBe("home");
  expect(joinReturnOf("not a path ::")).toBe("home");
});

test("a stored note counts only when fresh and well formed", () => {
  const now = Date.UTC(2026, 9, 10, 12);
  expect(readJoinReturn(JSON.stringify({ at: now - 60_000, view: "make" }), now)).toBe("make");
  expect(readJoinReturn(JSON.stringify({ at: now - 60_000, view: "home" }), now)).toBe("home");
  expect(readJoinReturn(JSON.stringify({ at: now - 7 * 60 * 60 * 1000, view: "make" }), now)).toBeNull();
  expect(readJoinReturn(JSON.stringify({ at: now + 60_000, view: "make" }), now)).toBeNull();
  expect(readJoinReturn(JSON.stringify({ at: now, view: "board" }), now)).toBeNull();
  expect(readJoinReturn("{", now)).toBeNull();
  expect(readJoinReturn(null, now)).toBeNull();
});
