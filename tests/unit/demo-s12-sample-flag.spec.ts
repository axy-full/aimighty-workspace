import { test, expect } from "@playwright/test";
import { DEFAULTS } from "../../lib/settings";
import {
  isSampleDraftId, isSampleProject, paidControlOnSample, parseSampleMark, sampleGate,
  SAMPLE_DRAFT_PREFIX, SAMPLE_LINE, SAMPLE_SETTING_KEY, type SampleMark,
} from "../../lib/demo/sample";

/**
 * The explore-only flag, as the browser reads it (lib/demo/sample.ts). Pure: the stored row's shape, the words every
 * paid control carries and the check "is this the sample?". The server writes the row only through the build action
 * (demo-s12-mark.spec.ts); this file holds what the screens do with it.
 */
const mark: SampleMark = { version: 1, projectId: "prj_film", name: "A film", draftOwner: "u_owner", draftId: "project-1", markedBy: "u_owner", markedAt: 5 };

test("the line is the one the design gives, and the setting is not one a workspace can set", () => {
  expect(SAMPLE_LINE).toBe("Sample production · nothing here spends credits");
  /* PATCH /api/settings only writes keys in DEFAULTS, so a key outside it can be written by the build action alone. */
  expect(Object.keys(DEFAULTS)).not.toContain(SAMPLE_SETTING_KEY);
});

test("a stored mark parses; a hidden, partial or foreign one reads as no sample", () => {
  expect(parseSampleMark(JSON.stringify(mark))).toEqual(mark);
  expect(parseSampleMark(mark)).toEqual(mark);
  expect(parseSampleMark({ ...mark, hiddenAt: 9, hiddenBy: "u_owner" })).toBeNull();
  expect(parseSampleMark({ ...mark, version: 2 })).toBeNull();
  expect(parseSampleMark({ ...mark, projectId: "" })).toBeNull();
  expect(parseSampleMark({ ...mark, draftOwner: undefined })).toBeNull();
  expect(parseSampleMark("not json")).toBeNull();
  expect(parseSampleMark(null)).toBeNull();
  expect(parseSampleMark(42)).toBeNull();
});

test("a production is the sample by its copy's id or by the marked production; nothing else is", () => {
  expect(isSampleDraftId(`${SAMPLE_DRAFT_PREFIX}abc`)).toBe(true);
  expect(isSampleDraftId("project-abc")).toBe(false);
  expect(isSampleDraftId(null)).toBe(false);
  /* The person's copy, before the mark has loaded. */
  expect(isSampleProject({ id: "sample-abc" }, null)).toBe(true);
  /* The owner's own draft of the marked production. */
  expect(isSampleProject({ id: "project-1", productionProjectId: "prj_film" }, mark)).toBe(true);
  /* Another production in the same workspace, and no mark at all. */
  expect(isSampleProject({ id: "project-2", productionProjectId: "prj_other" }, mark)).toBe(false);
  expect(isSampleProject({ id: "project-1", productionProjectId: "prj_film" }, null)).toBe(false);
  expect(isSampleProject({ id: "project-2" }, mark)).toBe(false);
  expect(isSampleProject(null, mark)).toBe(false);
  expect(isSampleProject(undefined, mark)).toBe(false);
});

test("the board's context: explore-only carries the line on the sample and nothing elsewhere; free actions are not read-only", () => {
  expect(sampleGate({ id: "sample-abc" }, null)).toEqual({ exploreOnly: SAMPLE_LINE, readOnly: null });
  expect(sampleGate({ id: "project-2", productionProjectId: "prj_other" }, mark)).toEqual({ exploreOnly: null, readOnly: null });
});

test("every paid control on the sample is disabled with the line; off the sample it is untouched", () => {
  const on = sampleGate({ id: "sample-abc" }, null), off = sampleGate({ id: "project-2" }, mark);
  expect(paidControlOnSample(on)).toEqual({ disabled: true, title: SAMPLE_LINE });
  expect(paidControlOnSample(off)).toEqual({ disabled: false });
});
