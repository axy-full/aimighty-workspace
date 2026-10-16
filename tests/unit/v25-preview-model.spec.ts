import { test, expect } from "@playwright/test";
import {
  approveLabel, canCompare, clampIndex, compareSides, judgeVersion, previewItemOfShot, stepFrame, stepId, timeLabel, versionDownload, versionOf, waveBars,
  type PreviewItemView,
} from "../../components/v12/board/preview-model";
import type { ShotVersion } from "../../components/graphite/board/cards/take/take-model";

/* PR 6: the preview's rules (components/v12/board/preview-model.ts). Pure. */
const ver = (n: number, status: PreviewItemView["versions"][number]["status"], over: Partial<PreviewItemView["versions"][number]> = {}) => ({ genId: `g${n}`, label: `v${n}`, url: `/api/media/g${n}`, poster: `/p/${n}`, status, ...over });
const item = (versions: PreviewItemView["versions"], over: Partial<PreviewItemView> = {}): PreviewItemView => ({ id: "s1", title: "Shot 1", kind: "picture", versions, shown: versions.length - 1, canJudge: true, reasons: [], ...over });

test("the version label and Compare need more than one version", () => {
  const one = item([ver(1, "ready")]);
  const three = item([ver(1, "rejected"), ver(2, "ready"), ver(3, "approved")]);
  expect(versionOf(one, 0)).toBe("");
  expect(canCompare(one)).toBe(false);
  expect(versionOf(three, 1)).toBe("v2 of 3");
  expect(versionOf(three, 99)).toBe("v3 of 3");
  expect(canCompare(three)).toBe(true);
  expect(clampIndex(-4, 3)).toBe(0);
  expect(clampIndex(7, 3)).toBe(2);
  expect(clampIndex(1.9, 3)).toBe(1);
  expect(clampIndex(0, 0)).toBe(0);
});

test("Compare puts the version before the one on screen (A) beside it (B); the first version is set against the second", () => {
  const three = item([ver(1, "ready"), ver(2, "ready"), ver(3, "ready")]);
  expect(compareSides(three, 2)).toEqual({ a: 1, b: 2 });
  expect(compareSides(three, 1)).toEqual({ a: 0, b: 1 });
  expect(compareSides(three, 0)).toEqual({ a: 0, b: 1 });
  expect(compareSides(item([ver(1, "ready"), ver(2, "ready")]), 0)).toEqual({ a: 0, b: 1 });
});

test("← and → walk the step's cards and wrap at either end", () => {
  const ids = ["a", "b", "c"];
  expect(stepId(ids, "a", 1)).toBe("b");
  expect(stepId(ids, "c", 1)).toBe("a");
  expect(stepId(ids, "a", -1)).toBe("c");
  expect(stepId(ids, "zzz", 1)).toBe("a");
  expect(stepId([], "a", 1)).toBe("a");
});

test("✓ and ✕ act on the version on screen, only when the card can be judged and that version can", () => {
  const three = item([ver(1, "rejected"), ver(2, "ready"), ver(3, "approved")]);
  expect(judgeVersion(three, 1)?.genId).toBe("g2");
  expect(approveLabel(three, 1)).toBe("Approve v2");
  expect(approveLabel(three, 2)).toBe("Approved");
  expect(approveLabel(item([ver(1, "ready")]), 0)).toBe("Approve");
  expect(judgeVersion({ ...three, canJudge: false }, 1)).toBeNull();
  expect(judgeVersion(item([ver(1, "making")]), 0)).toBeNull();
  expect(judgeVersion(item([ver(1, "none")]), 0)).toBeNull();
  expect(judgeVersion(item([ver(1, "ready", { genId: undefined })]), 0)).toBeNull();
  /* A version with no picture or clip here to look at cannot be judged. */
  expect(judgeVersion(item([ver(1, "ready", { url: null })]), 0)).toBeNull();
});

test("a clip's time and frame steps stay inside the clip", () => {
  expect(timeLabel(3.4, 8)).toBe("0:03 / 0:08");
  expect(timeLabel(65, 125)).toBe("1:05 / 2:05");
  expect(timeLabel(-2, 0)).toBe("0:00 / 0:00");
  expect(stepFrame(1, 8, 1, 24)).toBeCloseTo(1 + 1 / 24, 6);
  expect(stepFrame(0, 8, -1)).toBe(0);
  expect(stepFrame(8, 8, 1)).toBe(8);
  expect(stepFrame(2, 8, 1, 0)).toBeCloseTo(2 + 1 / 24, 6);
});

test("the waveform is a repeatable shape: the same take, the same bars, 12 to 100 percent tall", () => {
  const a = waveBars("take-1");
  expect(a).toHaveLength(40);
  expect(waveBars("take-1")).toEqual(a);
  expect(waveBars("take-2")).not.toEqual(a);
  for (const h of a) { expect(h).toBeGreaterThanOrEqual(12); expect(h).toBeLessThanOrEqual(100); }
  expect(waveBars("x", 10)).toHaveLength(10);
});

test("Download is the original as an attachment; a shot's takes become versions, oldest first, opening on the one the board shows", () => {
  expect(versionDownload({ url: "/api/media/gen_a" })).toBe("/api/media/gen_a?download=1");
  expect(versionDownload({ url: null })).toBeNull();
  const v = (n: number, status: ShotVersion["status"], over: Partial<ShotVersion> = {}) => ({
    genId: `g${n}`, label: `v${n}`, version: n, status, url: `/api/media/g${n}`, media: "image" as const, approvedBy: null, ...over,
  }) as unknown as ShotVersion;
  const versions = [v(1, "changes"), v(2, "review"), v(3, "approved", { approvedBy: "Reviewer One" })];
  const out = previewItemOfShot({ nodeId: "n1", title: "Shot 1 · Wide", versions, shown: versions[1], frame: null });
  expect(out.versions.map((x) => [x.label, x.status])).toEqual([["v1", "rejected"], ["v2", "ready"], ["v3", "approved"]]);
  expect(out.versions[2].approvedBy).toBe("Reviewer One");
  expect(out.shown).toBe(1);
  expect(out.kind).toBe("picture");
  expect(out.canJudge).toBe(true);
  const clip = previewItemOfShot({ nodeId: "n2", title: "Shot 2", versions: [v(1, "review", { media: "video", url: "/api/media/clip" })], shown: null, frame: { url: "/f.png", kind: "image" } });
  expect(clip.kind).toBe("video");
  expect(clip.versions[0].poster).toBe("/f.png");
  expect(previewItemOfShot({ nodeId: "n3", title: "Shot 3", versions: [], shown: null, frame: null })).toMatchObject({ versions: [], shown: 0, canJudge: false });
});
