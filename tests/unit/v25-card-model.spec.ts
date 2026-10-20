import { test, expect } from "@playwright/test";
import { canJudge, rejectReason, statusLine, withOther, type CardStatus } from "../../components/v12/board/card-model";

/* The v25 card system's rules (components/v12/board/card-model.ts; design/particl-prototype-25 README "CARD SYSTEM"). */

test("five statuses, said the same everywhere: Not started · Making… · Ready (· vN) · ✓ Approved · ✕ reason", () => {
  expect(statusLine({ status: "none" })).toEqual({ text: "Not started", tone: "muted", dot: "muted" });
  expect(statusLine({ status: "making" })).toEqual({ text: "Making…", tone: "muted", dot: "accent" });
  expect(statusLine({ status: "ready" })).toEqual({ text: "Ready", tone: "muted", dot: "done" });
  expect(statusLine({ status: "ready", version: 1 }).text).toBe("Ready");
  expect(statusLine({ status: "ready", version: 3 }).text).toBe("Ready · v3");
  expect(statusLine({ status: "approved", version: 3 })).toEqual({ text: "✓ Approved", tone: "done", dot: "done" });
  expect(statusLine({ status: "rejected", reason: "Look · warmer" })).toEqual({ text: "✕ Look · warmer", tone: "failed", dot: "failed" });
  expect(statusLine({ status: "rejected", reason: "  " }).text).toBe("✕");
  expect(statusLine({ status: "rejected" }).text).toBe("✕");
});

test("an item the person owns says what it is, not a status", () => {
  expect(statusLine({ status: "ready", own: "Brand kit · 3 files" })).toEqual({ text: "Brand kit · 3 files", tone: "muted", dot: "muted" });
  expect(statusLine({ status: "none", own: "Source clip" }).text).toBe("Source clip");
});

test("✓ and ✕ show on a card with something to judge, never on a user-owned card, a card not made yet, an option greyed out, or a card whose marks would do nothing", () => {
  const judged: CardStatus[] = ["ready", "approved", "rejected"];
  for (const status of judged) expect(canJudge({ status }), status).toBe(true);
  for (const status of judged) expect(canJudge({ status, acts: true }), status).toBe(true);
  for (const status of ["none", "making"] as CardStatus[]) expect(canJudge({ status }), status).toBe(false);
  for (const status of judged) {
    expect(canJudge({ status, userOwned: true })).toBe(false);
    expect(canJudge({ status, greyed: true })).toBe(false);
    expect(canJudge({ status, acts: false }), `${status} with nothing to call`).toBe(false);
  }
});

test("a step's reasons always end with Other, once", () => {
  expect(withOther(["Look", "Text"])).toEqual(["Look", "Text", "Other"]);
  expect(withOther(["Other", "Look"])).toEqual(["Look", "Other"]);
  expect(withOther([])).toEqual(["Other"]);
});

test("what ✕ records: the reason and the optional line", () => {
  expect(rejectReason("Look", "")).toBe("Look");
  expect(rejectReason("Look", " warmer ")).toBe("Look · warmer");
  expect(rejectReason("Other", "too long")).toBe("too long");
  expect(rejectReason("Other", "")).toBe("Other");
  expect(rejectReason(null, "no reason chip")).toBe("no reason chip");
  expect(rejectReason(null, "")).toBe("Other");
});
