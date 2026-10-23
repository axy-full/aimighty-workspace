import { test, expect } from "@playwright/test";
import { SHOT_REASONS, rejectedReason, shotCardPicture, shotCardState } from "../../components/v12/board/shot-card";
import { REJECT_CHIPS, type ShotVersion } from "../../components/graphite/board/cards/take/take-model";
import { REASON_NEEDS_LINE, reasonProblem, withOther } from "../../components/v12/board/card-model";

/* PR 5: a shot's takes as the v25 card reads them (components/v12/board/shot-card.ts). Pure. */
const v = (n: number, status: ShotVersion["status"], over: Partial<ShotVersion> = {}): ShotVersion => ({
  id: `generation:g${n}`, genId: `g${n}`, version: n, label: `v${n}`, status, stage: null, media: "image", url: `/m/${n}`, createdAt: n, engine: "", prompt: "", task: "generate", reason: null, charge: null,
  nothingBilled: false, retry: false, needs: null, approvedBy: null, approvedAt: null, reviewBy: null, updatedAt: n, references: [], entry: {} as never, ...over,
});
const row = (versions: ShotVersion[], shown: ShotVersion | null = versions[versions.length - 1] ?? null) => ({ versions, shown, frame: null as { url: string; kind: "image" | "video" } | null });

test("each take status reads as one of the card's five; a failed take and no take are Not started", () => {
  const status = (s: ShotVersion["status"], over: Partial<ShotVersion> = {}) => shotCardState(row([v(1, s, over)])).status;
  expect(status("review")).toBe("ready");
  expect(status("picked")).toBe("ready");
  expect(status("uploaded")).toBe("ready");
  expect(status("approved")).toBe("approved");
  expect(status("changes")).toBe("rejected");
  expect(status("rendering", { url: null })).toBe("making");
  expect(status("held", { url: null })).toBe("making");
  expect(status("failed", { url: null })).toBe("none");
  expect(shotCardState(row([])).status).toBe("none");
});

test("the version shows only when the shot has more than one, and is the shown one", () => {
  expect(shotCardState(row([v(1, "review")])).version).toBeUndefined();
  const two = [v(1, "changes"), v(2, "review")];
  expect(shotCardState(row(two))).toMatchObject({ status: "ready", version: 2 });
  expect(shotCardState(row(two, two[0]))).toMatchObject({ status: "rejected", version: 1 });
});

test("✓ and ✕ act on the shown version, and only when it can be judged: finished, with its picture here", () => {
  const done = v(1, "review");
  expect(shotCardState(row([done])).judge).toBe(done);
  expect(shotCardState(row([v(1, "review", { url: null })])).judge).toBeNull();
  expect(shotCardState(row([v(1, "review", { media: null })])).judge).toBeNull();
  for (const s of ["rendering", "held", "failed"] as const) expect(shotCardState(row([v(1, s)])).judge, s).toBeNull();
  expect(shotCardState(row([v(1, "approved")])).judge).not.toBeNull();
  expect(shotCardState(row([v(1, "changes")])).judge).not.toBeNull();
  expect(shotCardState(row([])).judge).toBeNull();
});

test("the picture is the shown still, else the storyboard frame when that is a still, else none", () => {
  expect(shotCardPicture({ shown: v(1, "review"), frame: null })).toEqual({ src: "/m/1" });
  expect(shotCardPicture({ shown: v(1, "review", { media: "video", url: "/m/clip.mp4" }), frame: { url: "/f.png", kind: "image" } })).toEqual({ src: "/f.png" });
  expect(shotCardPicture({ shown: v(1, "review", { media: "video", url: "/m/clip.mp4" }), frame: { url: "/f.mp4", kind: "video" } })).toBeNull();
  expect(shotCardPicture({ shown: null, frame: { url: "/f.png", kind: "image" } })).toEqual({ src: "/f.png" });
  expect(shotCardPicture({ shown: null, frame: null })).toBeNull();
});

test("✕'s reasons are the Shots chips word for word, ending in Other once; the reason shown is the team's latest note since the mark, in one line", () => {
  expect([...SHOT_REASONS]).toEqual([...REJECT_CHIPS]);
  expect(withOther(SHOT_REASONS).at(-1)).toBe("Other");
  expect(withOther(SHOT_REASONS).filter((r) => r === "Other")).toHaveLength(1);
  expect(rejectedReason(undefined, 0)).toBe("");
  expect(rejectedReason([], 0)).toBe("");
  expect(rejectedReason([{ text: "first", at: 10 }, { text: "  Off the brief \n · warmer ", at: 20 }], 10)).toBe("Off the brief · warmer");
  /* A client's comment from a review link is not the team's reason, even when it is the newest. */
  expect(rejectedReason([{ text: "Off the brief", at: 20 }, { text: "Love it", at: 30, guest: true }], 15)).toBe("Off the brief");
  /* A note from before the "changes" mark is older talk, not the reason it was sent back with. */
  expect(rejectedReason([{ text: "Nice light", at: 5 }], 10)).toBe("");
  expect(rejectedReason([{ text: "Nice light", at: 5 }, { text: "Wrong framing", at: 10 }], 10)).toBe("Wrong framing");
  /* Only guests since the mark: no reason (the card reads "✕"). */
  expect(rejectedReason([{ text: "Hmm", at: 12, guest: true }], 10)).toBe("");
});

test("a Ready card with nothing to judge offers nothing: an upload, a take with no picture here, an approved take with no picture here", () => {
  expect(shotCardState(row([v(1, "uploaded")]))).toMatchObject({ status: "ready", judge: null });
  expect(shotCardState(row([v(1, "review", { url: null })]))).toMatchObject({ status: "ready", judge: null });
  expect(shotCardState(row([v(1, "picked", { media: null })]))).toMatchObject({ status: "ready", judge: null });
  expect(shotCardState(row([v(1, "approved", { url: null })]))).toMatchObject({ status: "approved", judge: null });
});

test("on Shots, every chip but Other sends without a line; Other needs one, and one word is enough", () => {
  for (const chip of SHOT_REASONS) expect(reasonProblem(chip, ""), chip).toBeNull();
  expect(reasonProblem("Other", "")).toBe(REASON_NEEDS_LINE);
  expect(reasonProblem("Other", "dark")).toBeNull();
});
