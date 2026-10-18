import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { DRAFT_HOLDS, resolutionPick, resolutionQuery, resolutionView, sizeLabel, type ResolutionReply } from "../../lib/shell/resolution-control";
import { NOT_ON_ENGINE, UPSCALED_4K } from "../../lib/resolutions";

/**
 * Make's Resolution control (owner, 16 Oct 2026, § D), apart from how it is drawn. The options and their figures are the server's
 * (POST /api/generate/resolutions); the figures below are inputs, as the server would send them, never prices of ours.
 */
const SEEDANCE: ResolutionReply = {
  model: "seedance",
  options: [
    { id: "480p", label: "480p", kind: "native", available: true, estimatedCredits: 11, price: 11, unit: "cr" },
    { id: "720p", label: "720p", kind: "native", available: true, estimatedCredits: 22, price: 22, unit: "cr" },
    { id: "1080p", label: "1080p", kind: "native", available: true, estimatedCredits: 44, price: 44, unit: "cr" },
    { id: "4k", label: "4K", kind: "native", available: false, reason: NOT_ON_ENGINE },
    { id: UPSCALED_4K, label: "4K upscaled", kind: "upscaled", available: true, from: "1080p", estimatedCredits: 66, price: 66, unit: "cr",
      steps: [{ tool: "render", resolution: "1080p", estimatedCredits: 44, price: 44, unit: "cr" }, { tool: "upscale", resolution: "4k", estimatedCredits: 22, price: 22, unit: "cr" }] },
  ],
};
const base = { resolutions: ["480p", "720p", "1080p"], resolution: "1080p", draft: false, upscale: false, video: true, reply: SEEDANCE };

test("the engine's sizes come from the server with its figures; a size it cannot do is greyed with 'not on this engine' and no price", () => {
  const view = resolutionView(base);
  expect(view.sizes.map((s) => [s.id, s.label, s.enabled, s.off, s.pressed])).toEqual([
    ["480p", "480p", true, false, false], ["720p", "720p", true, false, false], ["1080p", "1080p", true, false, true], ["4k", "4K", false, true, false],
  ]);
  expect(view.sizes.map((s) => s.price)).toEqual([{ kind: "exact", credits: 11 }, { kind: "exact", credits: 22 }, { kind: "exact", credits: 44 }, null]);
  expect(view.sizes[3].reason).toBe("not on this engine");
  /* A dollars workspace sees the server's dollars beside the credits; nothing is worked out here. */
  const house = resolutionView({ ...base, reply: { ...SEEDANCE, options: SEEDANCE.options.map((o) => ({ ...o, unit: "usd" as const, price: 1.25 })) } });
  expect(house.sizes[0].price).toEqual({ kind: "exact", credits: 11, usd: 1.25 });
});

test("Draft (480p) and Final (1080p) are presets over the same sizes; the size stays visible and changeable", () => {
  const view = resolutionView(base);
  expect(view.presets.map((p) => [p.name, p.id, p.enabled, p.pressed])).toEqual([["Draft", "480p", true, false], ["Final", "1080p", true, true]]);
  expect(resolutionPick(view, "480p")).toEqual({ resolution: "480p", upscale: false });
  /* An engine without 480p (Kling makes 1080p only) greys the Draft preset the same way. */
  const kling = resolutionView({ ...base, resolutions: ["1080p"], reply: null });
  expect(kling.presets.map((p) => [p.name, p.enabled, p.off, p.reason])).toEqual([["Draft", false, true, NOT_ON_ENGINE], ["Final", true, false, null]]);
  expect(resolutionPick(kling, "480p")).toBeNull();
  /* While a draft is on, the size is held at 480p and says why; nothing else can be picked. */
  const draft = resolutionView({ ...base, resolution: "480p", draft: true });
  expect(draft.sizes.filter((s) => s.enabled).map((s) => s.id)).toEqual(["480p"]);
  expect(draft.sizes.find((s) => s.id === "1080p")?.reason).toBe(DRAFT_HOLDS);
  expect(draft.presets.every((p) => !p.pressed)).toBe(true);
  expect(draft.upscaled?.enabled).toBe(false);
});

test("native 4K and upscaled 4K are separate options: the upscale sends the render's size and carries both steps' figures", () => {
  const view = resolutionView(base);
  expect(view.upscaled).toMatchObject({ id: UPSCALED_4K, label: "4K upscaled", enabled: true, pressed: false, from: "1080p",
    price: { kind: "exact", credits: 66 }, render: { kind: "exact", credits: 44 }, upscale: { kind: "exact", credits: 22 } });
  expect(resolutionPick(view, UPSCALED_4K)).toEqual({ resolution: "1080p", upscale: true });
  const picked = resolutionView({ ...base, upscale: true });
  expect(picked.upscaled?.pressed).toBe(true);
  /* With the upscale picked, the plain 1080p (and the Final preset) is not the pick. */
  expect(picked.sizes.find((s) => s.id === "1080p")?.pressed).toBe(false);
  expect(picked.presets.find((p) => p.name === "Final")?.pressed).toBe(false);
  /* An engine that lists its own 4K shows it as a native size beside the upscale. */
  const two = resolutionView({ ...base, resolutions: ["480p", "720p", "1080p", "4k"], reply: { model: "two", options: [
    ...SEEDANCE.options.slice(0, 3), { id: "4k", label: "4K", kind: "native", available: true, untested: true, estimatedCredits: 90, price: 90, unit: "cr" }, SEEDANCE.options[4],
  ] } });
  expect(two.sizes.find((s) => s.id === "4k")).toMatchObject({ enabled: true, off: false, untested: true, price: { kind: "exact", credits: 90 } });
  expect(two.upscaled?.enabled).toBe(true);
  /* A still has its own sizes, and no presets or upscale. */
  const still = resolutionView({ ...base, video: false, resolutions: ["1K", "2K", "4K"], resolution: "1K", reply: null });
  expect(still.presets).toEqual([]);
  expect(still.upscaled).toBeNull();
  expect(still.sizes.map((s) => [s.id, s.enabled, s.price])).toEqual([["1K", true, null], ["2K", true, null], ["4K", true, null]]);
});

test("no figure is shown that the server did not give for these settings: before it answers, when it could not price, or with references", () => {
  expect(resolutionView({ ...base, reply: null }).sizes.map((s) => [s.id, s.enabled, s.price])).toEqual([["480p", true, null], ["720p", true, null], ["1080p", true, null]]);
  const problem = resolutionView({ ...base, reply: { ...SEEDANCE, options: [{ ...SEEDANCE.options[0], problem: "This could not be priced." }, ...SEEDANCE.options.slice(1)] } });
  expect(problem.sizes[0]).toMatchObject({ enabled: true, price: null, reason: "This could not be priced." });
  const refs = resolutionView({ ...base, unpriced: true });
  expect([...refs.sizes, ...refs.presets].every((s) => s.price === null)).toBe(true);
  expect(refs.upscaled).toMatchObject({ price: null, render: null, upscale: null });
  /* A size the server lists that the composer's own list does not is never pressed or sent. */
  const extra = resolutionView({ ...base, resolutions: ["480p", "1080p"] });
  expect(extra.sizes.find((s) => s.id === "720p")).toMatchObject({ enabled: false, off: true });
  expect(resolutionPick(extra, "720p")).toBeNull();
});

test("the read the control makes sends no words and no spend marker: the route prices, and the press that spends is Make's own", () => {
  expect(resolutionQuery({ model: "m", ratio: "16:9", duration: 5 })).toEqual({ model: "m", ratio: "16:9", duration: 5 });
  expect(resolutionQuery({ model: "m", ratio: "16:9", duration: 5, generateAudio: true })).toEqual({ model: "m", ratio: "16:9", duration: 5, generateAudio: true });
  expect(sizeLabel("4k")).toBe("4K");
  expect(sizeLabel("1080P")).toBe("1080p");
  const hook = readFileSync("components/graphite/make/use-resolutions.ts", "utf8");
  expect(hook).toContain('"/api/generate/resolutions"');
  expect(hook).not.toMatch(/maxCredits|quoteOnly|"\/api\/generate"/);
  const view = readFileSync("lib/shell/resolution-control.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  expect(view).not.toMatch(/\b\d+\.\d+\b/);
});
