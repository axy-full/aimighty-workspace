import { test, expect } from "@playwright/test";
import {
  REASON_NEEDS_LINE, REASON_TOO_LONG, V25_JUDGE, canJudge, reasonProblem, reasonTextProblem, rejectReason, statusLine, withOther, type CardStatus,
} from "../../components/v12/board/card-model";

/* The v25 card system's rules (components/v12/board/card-model.ts; design/particl-prototype-25 README "CARD SYSTEM"). */

test("five statuses, said the same everywhere: Not started · Making… · Ready (· vN) · ✓ Sent · ✕ reason", () => {
  expect(statusLine({ status: "none" })).toEqual({ text: "Not started", tone: "muted", dot: "muted" });
  expect(statusLine({ status: "making" })).toEqual({ text: "Making…", tone: "muted", dot: "accent" });
  expect(statusLine({ status: "ready" })).toEqual({ text: "Ready", tone: "muted", dot: "done" });
  expect(statusLine({ status: "ready", version: 1 }).text).toBe("Ready");
  expect(statusLine({ status: "ready", version: 3 }).text).toBe("Ready · v3");
  /* The trail's "approved" mark reads Sent (owner, 20 Oct 2026: "Demo: the card says Sent."); the data value stays "approved". */
  expect(statusLine({ status: "approved", version: 3 })).toEqual({ text: "✓ Sent", tone: "done", dot: "done" });
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

test("✕'s reason rule: Other needs a line, one word is enough; another chip sends without one; at most 500 characters", () => {
  /* Other, or no chip, with nothing typed: refused, and the panel says why. */
  expect(REASON_NEEDS_LINE).toBe("Other needs a line: one word is enough.");
  expect(reasonProblem("Other", "")).toBe(REASON_NEEDS_LINE);
  expect(reasonProblem("Other", "   ")).toBe(REASON_NEEDS_LINE);
  expect(reasonProblem(null, "")).toBe(REASON_NEEDS_LINE);
  expect(reasonProblem(null, " \t ")).toBe(REASON_NEEDS_LINE);
  /* Other with any word: sent, even one or two letters (the take cards' 3-character floor is not the v25 card's rule). */
  expect(reasonProblem("Other", "ok")).toBeNull();
  expect(reasonProblem("Other", "x")).toBeNull();
  expect(reasonProblem("Other", "too dark")).toBeNull();
  expect(reasonProblem(null, "ok")).toBeNull();
  /* A chip other than Other sends with or without a line. */
  expect(reasonProblem("Look", "")).toBeNull();
  expect(reasonProblem("Look", "warmer")).toBeNull();
  /* Too long: said as too long. */
  expect(REASON_TOO_LONG).toBe("Too long: 500 characters at most.");
  expect(reasonProblem("Other", "x".repeat(500))).toBeNull();
  expect(reasonProblem("Other", "x".repeat(501))).toBe(REASON_TOO_LONG);
  expect(reasonProblem("Look", "x".repeat(500))).toBe(REASON_TOO_LONG);
  /* On the recorded reason (what the judge is handed): some words, at most 500. */
  expect(reasonTextProblem("")).toBe(REASON_NEEDS_LINE);
  expect(reasonTextProblem("ok")).toBeNull();
  expect(reasonTextProblem("x".repeat(501))).toBe(REASON_TOO_LONG);
});

test("the v25 judge says sent and uses the card's reason rule; it changes no value it writes", () => {
  expect(V25_JUDGE.approved).toBe("sent");
  expect(V25_JUDGE.reasonProblem).toBe(reasonTextProblem);
  expect(Object.keys(V25_JUDGE).sort()).toEqual(["approved", "reasonProblem"]);
});
