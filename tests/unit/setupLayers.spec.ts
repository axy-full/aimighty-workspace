import { test, expect } from "@playwright/test";
import { layerSetup, setupDiff, diffLine, appliedSetup } from "../../lib/setupLayers";

const label = (k: string, v: string) => ({ lens: { "35": "35mm", "85": "85mm" }, time: { golden: "Golden hour" }, move: { handheld: "Handheld", static: "Locked off" }, shot: { ws: "Wide" } } as Record<string, Record<string, string>>)[k]?.[v] ?? v;

/** Setup you can see and override (brief 2.3): four layers, each overriding the one above, every value knowing its source. */
test("later layers override earlier ones, and each active value says where it came from", () => {
  const l = layerSetup({ platform: { lens: "50", time: "day", move: "static" }, workspace: { lens: "35" }, production: { time: "golden", look: "" }, shot: { move: "handheld" } });
  expect(l.effective).toEqual({ lens: "35", time: "golden", move: "handheld" });
  expect(l.sources).toEqual({ lens: "workspace", time: "production", move: "shot" });
  expect(layerSetup({}).effective).toEqual({});
  expect(layerSetup({ shot: { lens: "85" } }).sources.lens).toBe("shot");
});

test("the prompt's own words read as overrides, and the line says so", () => {
  const l = layerSetup({ workspace: { lens: "35", time: "golden", move: "handheld" } });
  const d = setupDiff(l, { move: "static", shot: "ws" }, ["shot", "move", "lens", "time"]);
  expect(d.active.map((r) => r.key)).toEqual(["lens", "time"]);
  expect(d.overrides).toEqual([{ key: "move", setupValue: "handheld", promptValue: "static" }]);
  expect(d.added).toEqual([{ key: "shot", value: "ws" }]);
  expect(diffLine(d, label)).toBe("Setup: 35mm · Golden hour — this shot overrides: Handheld");
  expect(diffLine(setupDiff(l, {}), label)).toBe("Setup: 35mm · Golden hour · Handheld");
  expect(diffLine(setupDiff(layerSetup({}), {}), label)).toBe("");
  expect(appliedSetup(l, { move: "static", shot: "ws" })).toEqual({ lens: "35", time: "golden", move: "static", shot: "ws" });
});
