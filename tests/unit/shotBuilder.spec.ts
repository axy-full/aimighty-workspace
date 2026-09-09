import { test, expect } from "@playwright/test";
import { suggestEngine, shotsFromReply, cleanSetupFields, ENGINE_MODEL } from "../../lib/shotBuilder";
import { shotCostUsd } from "../../lib/shotCost";
import { estimateCostUsd } from "../../lib/vendorPricing";

/** The shot builder's pure half (brief 1.8): the engine rule, the structured reply read into shots, and credits per shot before rendering. */
test("water, cloth and physics go to Kling; everything else to Seedance; a still to Nano Banana", () => {
  expect(suggestEngine("a red silk dress in the rain").engine).toBe("kling");
  expect(suggestEngine("a courier crosses a quiet street at dawn").engine).toBe("seedance");
  expect(suggestEngine("a product on a table", "image").engine).toBe("nano-banana");
});

test("a reply becomes validated shots: rows only from the bank, cast only from the names given, engine by the rule when missing", () => {
  const text = 'Sure: {"shots":[{"title":"Splash","description":"The wheel cuts through a flooded gutter.","planned":"4","setup":{"shot":"cu","move":"nope","angle":"Low"},"cast":["@Mara","@Nobody"],"why":""},{"description":"","title":"empty"}]} done';
  const shots = shotsFromReply(text, ["Mara"])!;
  expect(shots.length).toBe(1);
  expect(shots[0].engine).toBe("kling");
  expect(shots[0].setup).toEqual(expect.objectContaining({ shot: "cu" }));
  expect(shots[0].setup.move).toBeUndefined();
  expect(shots[0].cast).toEqual(["Mara"]);
  expect(shots[0].planned).toBe(4);
  expect(shotsFromReply("no json")).toBeNull();
  expect(cleanSetupFields({ shot: "Wide", time: "dawn", junk: "x" })).toEqual({ shot: "ws", time: "dawn" });
});

test("a shot's take is priced at its engine, five seconds at least on Seedance", () => {
  expect(shotCostUsd("seedance", 3)).toBe(estimateCostUsd(ENGINE_MODEL.seedance, "1080p", "16:9", 5, 0, false, { audio: true })!.net);
  expect(shotCostUsd("kling", 4)).toBe(estimateCostUsd(ENGINE_MODEL.kling, "1080p", "16:9", 5, 0, false, { audio: false })!.net);
  expect(shotCostUsd("nano-banana", null)).toBeGreaterThan(0);
});
