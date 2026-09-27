import { test, expect } from "@playwright/test";
import { visibleUsageParams } from "../../lib/usageParams";

test("usage returns display settings without execution state or unknown fields", () => {
  expect(visibleUsageParams(JSON.stringify({
    resolution: "1080p", ratio: "16:9", duration: 4, steps: 12,
    paidClaim: { state: "accepted" }, credentialFingerprint: "private-test-fingerprint",
    providerPoll: { token: "private-test-token", url: "https://example.invalid/private" },
    futureInternalField: "private-test-value",
  }))).toEqual({ resolution: "1080p", ratio: "16:9", duration: 4, steps: 12 });
});

test("malformed and non-object stored parameters fail closed", () => {
  for (const raw of [undefined, null, "", "{broken", "null", "[]", "7", '"settings"'])
    expect(visibleUsageParams(raw)).toEqual({});
});

test("allowed names cannot carry nested state, oversized strings or non-finite numbers", () => {
  expect(visibleUsageParams('{"resolution":{"token":"private-test-token"},"ratio":"' + "x".repeat(41) + '","duration":1e999,"steps":"12"}')).toEqual({});
  expect(visibleUsageParams('{"resolution":"720p","ratio":[],"duration":0,"steps":null}')).toEqual({ resolution: "720p", duration: 0 });
});
