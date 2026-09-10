import { test, expect } from "@playwright/test";
import { billCreditsWith, marginFor, DEFAULT_MARGINS } from "../../lib/creditTerms";

/** The rounding rule every price on a button and every meter row shares. */
test("nothing costs nothing; anything that costs money costs at least one credit", () => {
  expect(billCreditsWith(0, 1.4, 0.1)).toBe(0);
  expect(billCreditsWith(-1, 1.4, 0.1)).toBe(0);
  expect(billCreditsWith(0.0003, 1, 0.1)).toBe(1);
});

test("a job rounds up to the next whole credit at its engine's margin", () => {
  /* Every number here is `ceil(vendor x 1.5 / 0.10)` — SOW §7A, whose whole
     rate card derives from that and nothing else. Written out rather than
     computed, because a test that recomputes the rule it is checking passes
     whatever the rule becomes. */
  // A 5-second Seedance 2.5 1080p shot, $2.864 at the vendor. §7A card: 43.
  expect(billCreditsWith(2.864, marginFor("dreamina-seedance-2-5-260628", DEFAULT_MARGINS), 0.1)).toBe(43);
  // A 5-second Kling 3.0 standard shot, $0.42.
  expect(billCreditsWith(0.42, marginFor("fal-ai/kling-video/v3/standard", DEFAULT_MARGINS), 0.1)).toBe(7);
  // One Nano Banana Pro still, $0.134. §7A card: 3 at $0.15.
  expect(billCreditsWith(0.134, marginFor("gemini-3-pro-image", DEFAULT_MARGINS), 0.1)).toBe(3);
  // A whole-number boundary rounds exactly, not up again.
  expect(billCreditsWith(1, 1, 0.1)).toBe(10);
});

test("every engine is on the launch multiplier, and it is 1.5", () => {
  /* §7A: "Sell price = engine cost x 1.5." One rate at launch, keyed by
     engine so Phase B is a config change. A second entry appearing here is
     a pricing decision and should fail until it is a deliberate one. */
  expect(Object.keys(DEFAULT_MARGINS)).toEqual(["*"]);
  expect(DEFAULT_MARGINS["*"]).toBe(1.5);
  for (const engine of [
    "dreamina-seedance-2-5-260628", "fal-ai/kling-video/v3/pro", "gemini-3-pro-image",
    "identity-training", "elevenlabs", "text", "anything-not-yet-built",
  ]) expect(marginFor(engine, DEFAULT_MARGINS), engine).toBe(1.5);
});

test("the §7A rate card is what the code actually charges", () => {
  /* The card is published. If these disagree, one of them is lying to a
     customer, and it was the card for four days. */
  const card: [string, number, number][] = [
    ["Standard panel (Nano Banana fast)", 0.04, 1],
    ["Keyframe still (Nano Banana Pro)", 0.15, 3],
    ["Wan 2.6 draft, 5s", 0.25, 4],
    ["Kling 3.0 Standard, 5s", 0.50, 8],
    ["Kling 3.0 Pro, 5s, audio", 1.68, 26],
    ["Seedance 2.5, 5s, 720p", 1.60, 24],
    ["Seedance 2.5, 5s, 1080p", 2.86, 43],
    ["Veo 3.1, 5s, audio", 2.00, 30],
    ["Topaz upscale, 5s", 0.40, 6],
    ["VO line (ElevenLabs)", 0.03, 1],
    ["Identity training", 2.00, 30],
    ["Prompt enhancement", 0.01, 1],
  ];
  for (const [what, cost, sells] of card) {
    expect(billCreditsWith(cost, DEFAULT_MARGINS["*"], 0.1), what).toBe(sells);
  }
});

test("batches multiply before they round", () => {
  const unit = 0.134;
  const four = billCreditsWith(unit * 4, marginFor("gemini-3-pro-image", DEFAULT_MARGINS), 0.1);
  expect(four).toBe(9);
  expect(four).toBeLessThanOrEqual(4 * billCreditsWith(unit, marginFor("gemini-3-pro-image", DEFAULT_MARGINS), 0.1));
});

test("an unknown engine falls back to the table's default margin", () => {
  expect(marginFor("some-new-engine", DEFAULT_MARGINS)).toBe(DEFAULT_MARGINS["*"]);
  expect(marginFor(null, DEFAULT_MARGINS)).toBe(DEFAULT_MARGINS["*"]);
});

test("the markup does not cross the wire", async () => {
  /* SOW §2: "margin is the gap, set platform-side per engine, never shown."
     `CreditState` is what /api/me hands the browser, and it carried the
     margin table long after the browser stopped converting anything with it.
     One flat 1.5 is a plainer disclosure than fourteen numbers were, which is
     what made the dead field worth removing rather than leaving.

     Asserted on the shape rather than on a response, because the leak was a
     field on a type — anything that serialises this gets it for free. */
  const { creditStateFor } = await import("../../lib/credits");
  const ws = {
    id: "ws_margin", slug: "m", name: "M", legacy: false, usesPlatformKeys: true,
    dbUrl: process.env.TURSO_DATABASE_URL, dbToken: null, keys: {}, allowanceUsd: null,
    gatewayKeyId: null, ownerId: "u", createdAt: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const state = await creditStateFor(ws);
  expect(state, "a platform-keyed workspace has a balance").not.toBeNull();
  expect(Object.keys(state!).sort()).toEqual(["balance", "creditUsd", "granted", "used"]);
  expect(JSON.stringify(state)).not.toContain("1.5");
});
