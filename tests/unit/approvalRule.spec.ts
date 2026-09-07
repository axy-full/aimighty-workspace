import { test, expect } from "@playwright/test";
import { cleanRule, cleanShotCap, ruleLine, shotCapVerdict } from "../../lib/approvalRule";

const cr = (n: number) => `${n} cr`;

/** The cost approval rule (brief 2.2): said before the press, and enforced at it for members under "cap per shot". */
test("the rule and its cap are read strictly, and the composer's line follows the rule", () => {
  expect(cleanRule("cap")).toBe("cap");
  expect(cleanRule("nonsense")).toBe("anyone");
  expect(cleanShotCap("50")).toBe(50);
  expect(cleanShotCap("0")).toBe(50);
  expect(cleanShotCap("12.7")).toBe(13);
  expect(cleanShotCap(undefined)).toBe(50);
  expect(ruleLine("anyone", 50, cr)).toBe("");
  expect(ruleLine("cap", 50, cr)).toBe("Over 50 cr on a shot needs an admin.");
  expect(ruleLine("producer", 50, cr)).toBe("A producer signs off on every take.");
});

test("a member's take past the shot's cap is refused with the sentence that says so; an admin's is not", () => {
  const base = { rule: "cap" as const, cap: 50, shotCredits: 40, takeCredits: 23, code: "SH010" };
  const member = shotCapVerdict({ ...base, isAdmin: false }, cr);
  expect(member.blocked).toBe(true);
  expect(member.line).toBe("SH010 is at 40 cr; this take makes it 63 cr, over the 50 cr a shot may take. An admin has to press this one.");
  expect(shotCapVerdict({ ...base, isAdmin: true }, cr).blocked).toBe(false);
  expect(shotCapVerdict({ ...base, isAdmin: false, shotCredits: 20 }, cr).blocked).toBe(false);   // 43 ≤ 50
  expect(shotCapVerdict({ ...base, isAdmin: false, rule: "anyone" }, cr).blocked).toBe(false);
  expect(shotCapVerdict({ ...base, isAdmin: false, rule: "producer" }, cr).blocked).toBe(false);
});
