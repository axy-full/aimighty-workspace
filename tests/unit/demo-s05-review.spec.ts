import { test, expect } from "@playwright/test";
import { shotTakes } from "../../components/graphite/board/cards/take/take-model";
import {
  COMPARE_LABEL, REVIEW_KEYS, compareBase, nextCompare, positionWords, reviewAction, reviewQueue, reviewVersion, startIndex, typingIn,
} from "../../components/graphite/board/review/review-model";
import { entries, gen, project } from "./demo-s05-fixtures";

/* Stream 5 · review mode (design/particl-graphite/README.md § 3.1 l, § 6). */

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

test("J and K step through the takes, A approves, R rejects, Space plays, C compares, Esc closes; chords are never review's", () => {
  expect(["j", "J", "k", "a", "r", " ", "c", "Escape", "x"].map((k) => reviewAction(key(k)))).toEqual(["prev", "prev", "next", "approve", "reject", "play", "compare", "close", null]);
  expect(reviewAction(key("k", { metaKey: true }))).toBeNull();
  expect(reviewAction(key("a", { ctrlKey: true }))).toBeNull();
  expect(reviewAction(key("c", { altKey: true }))).toBeNull();
  expect(REVIEW_KEYS.map((k) => `${k.key} ${k.label}`)).toEqual(["J previous", "K next", "A approve", "R reject", "Space play", "C compare"]);
});

test("compare cycles Single, Side by side, Slider", () => {
  expect([nextCompare("single"), nextCompare("side"), nextCompare("slider")]).toEqual(["side", "slider", "single"]);
  expect(Object.values(COMPARE_LABEL)).toEqual(["Single", "Side by side", "Slider"]);
  expect(positionWords(1, 3, "v2")).toBe("take 2 of 3 · v2");
});

test("the queue holds one stop per shot with a take to judge, and opens where it was asked", () => {
  const s1 = gen({ shotId: "s1", version: 1, reviewState: "approved" });
  const s2a = gen({ shotId: "s2", version: 1, reviewState: "changes" });
  const s2b = gen({ shotId: "s2", version: 2 });
  const s3 = gen({ shotId: "s3", version: 1, status: "running", storedUrl: null });
  const rows = shotTakes(project(), entries([s1, s2a, s2b, s3]));
  const queue = reviewQueue(rows);
  expect(queue.map((r) => r.nodeId)).toEqual(["n1", "n2"]);
  expect(startIndex(queue, `generation:${s2a.id}`)).toBe(1);
  expect(startIndex(queue, s1.id)).toBe(0);
  /* Nothing asked: the first take that waits for a person. */
  expect(startIndex(queue, null)).toBe(1);
  expect(startIndex([], null)).toBe(-1);

  expect(reviewVersion(queue[1])?.genId).toBe(s2b.id);
  expect(reviewVersion(queue[1], s2a.id)?.genId).toBe(s2a.id);
  /* The approved version is what another is compared with; else the one before; with one version, nothing. */
  expect(compareBase(queue[1], reviewVersion(queue[1])!)?.genId).toBe(s2a.id);
  expect(compareBase(queue[1], reviewVersion(queue[1], s2a.id)!)?.genId).toBe(s2b.id);
  expect(compareBase(queue[0], reviewVersion(queue[0])!)).toBeNull();
  const withApproved = shotTakes(project(), entries([gen({ shotId: "s1", version: 1, reviewState: "approved" }), gen({ shotId: "s1", version: 2 }), gen({ shotId: "s1", version: 3 })]))[0];
  expect(compareBase(withApproved, reviewVersion(withApproved)!)?.label).toBe("v1");
});

test("keys typed into a field are the field's", () => {
  expect(typingIn({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
  expect(typingIn({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
  expect(typingIn({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
  expect(typingIn({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
  expect(typingIn(null)).toBe(false);
});
