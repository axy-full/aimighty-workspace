import { test, expect } from "@playwright/test";
import { reportInput } from "../../lib/reports";
import { policyAccepted } from "../../lib/policyAccept";

/** A report needs a place and a reason; sign-up needs the policy read. */
test("a report needs where and what, and an email only when it looks like one", () => {
  expect(reportInput({ url: "https://particlstudio.com/x", reason: "harassment", details: " d ", email: "" })).toEqual({ ok: true, value: { url: "https://particlstudio.com/x", reason: "harassment", details: "d", email: null } });
  expect(reportInput({ url: "", reason: "other" }).ok).toBe(false);
  expect(reportInput({ url: "gen_1", reason: "nope" }).ok).toBe(false);
  expect(reportInput({ url: "gen_1", reason: "other", email: "not-an-email" }).ok).toBe(false);
  expect(reportInput({ url: "gen_1", reason: "other", email: "A@B.co" })).toMatchObject({ ok: true, value: { email: "a@b.co" } });
});

test("sign-up records that the policy was read, or refuses", () => {
  expect(policyAccepted({ accept: true })).toBe(true);
  expect(policyAccepted({ accept: "yes" })).toBe(false);
  expect(policyAccepted({})).toBe(false);
});
