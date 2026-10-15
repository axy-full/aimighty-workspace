import { test, expect } from "@playwright/test";
import { DRIFT_DETAILS, REJECT_REASONS, REJECT_REASON_LABELS, cleanReasons, isRejectReason } from "../../lib/rejectReasons";
import { REJECT_CHIPS } from "../../components/graphite/board/cards/take/take-model";
import { readFileSync } from "node:fs";
import { uiWordsIn } from "../helpers/uiStrings";

/** The closed list of reject reasons (lib/rejectReasons.ts; docs/plans/step-0-data.md item 2): pure, no schema. */

test("the board's five chips map one to one onto the first five codes, word for word; the list is closed", () => {
  expect(REJECT_REASONS.slice(0, 5).map((code) => REJECT_REASON_LABELS[code])).toEqual([...REJECT_CHIPS]);
  expect(REJECT_REASONS).toEqual(["off_brief", "framing", "motion", "drift", "artifacts", "audio", "other"]);
  expect(Object.keys(REJECT_REASON_LABELS).sort()).toEqual([...REJECT_REASONS].sort());
  expect(new Set(Object.values(REJECT_REASON_LABELS)).size).toBe(REJECT_REASONS.length);
  expect(DRIFT_DETAILS).toEqual(["identity", "wardrobe", "environment", "props"]);
  for (const bad of ["", "Off the brief", "OFF_BRIEF", 3, null, {}, ["off_brief"]]) expect(isRejectReason(bad), JSON.stringify(bad)).toBe(false);
});

test("a request's reasons are optional, and checked: unknown codes and a stray detail are refused; the codes come back in the list's order, once", () => {
  expect(cleanReasons(undefined, undefined)).toEqual({ ok: true, value: { reasons: [], drift: null } });
  expect(cleanReasons([], null)).toEqual({ ok: true, value: { reasons: [], drift: null } });
  expect(cleanReasons(["artifacts", "framing", "framing"], undefined)).toEqual({ ok: true, value: { reasons: ["framing", "artifacts"], drift: null } });
  expect(cleanReasons(["drift"], "wardrobe")).toEqual({ ok: true, value: { reasons: ["drift"], drift: "wardrobe" } });
  for (const [reasons, drift] of [[["nope"], undefined], ["framing", undefined], [[1], undefined], [["framing"], "identity"], [["drift"], "mood"], [["drift"], 4], [new Array(9).fill("other"), undefined]] as const)
    expect(cleanReasons(reasons, drift), JSON.stringify([reasons, drift])).toMatchObject({ ok: false });
});

test("the labels use no retired word (the one vocabulary)", () => {
  expect(uiWordsIn("lib/rejectReasons.ts", readFileSync("lib/rejectReasons.ts", "utf8"))).toEqual([]);
});
