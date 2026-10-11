import { test, expect } from "@playwright/test";
import { tabTitle } from "../../components/v12/ui/tab-title";
import { TOAST_ACTION_MS, TOAST_MS, toastDuration } from "../../components/v12/ui/toast-time";

/* The browser tab's title while results wait (components/v12/ui/tab-title.ts) and how long a toast stays. */

test("the tab title reads (N ready) Particl while results wait, and the plain title otherwise", () => {
  expect(tabTitle(0)).toBe("Particl");
  expect(tabTitle(1)).toBe("(1 ready) Particl");
  expect(tabTitle(3)).toBe("(3 ready) Particl");
  expect(tabTitle(2, "Dune Studies · Particl")).toBe("(2 ready) Dune Studies · Particl");
});

test("the count is never stacked twice, never negative and never fractional", () => {
  expect(tabTitle(4, "(1 ready) Particl")).toBe("(4 ready) Particl");
  expect(tabTitle(0, "(5 ready) Particl")).toBe("Particl");
  expect(tabTitle(-2)).toBe("Particl");
  expect(tabTitle(2.7)).toBe("(2 ready) Particl");
  expect(tabTitle(Number.NaN)).toBe("Particl");
  expect(tabTitle(1, "")).toBe("(1 ready) Particl");
});

test("a toast stays 2.6 s, or 5 s when it carries Undo or View", () => {
  expect(TOAST_MS).toBe(2600);
  expect(TOAST_ACTION_MS).toBe(5000);
  expect(toastDuration({ text: "Board renamed" })).toBe(2600);
  expect(toastDuration({ text: "Shot 3 removed", action: { label: "Undo", run: () => {} } })).toBe(5000);
  expect(toastDuration({ text: "Shot 3 is ready", action: { label: "View", run: () => {} } })).toBe(5000);
});
