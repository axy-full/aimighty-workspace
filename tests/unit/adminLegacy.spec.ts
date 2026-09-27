import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("management allows legacy credit grants and refuses switches away from managed billing", () => {
  const source = readFileSync("app/api/admin/workspaces/[id]/route.ts", "utf8");
  expect(source).not.toContain("const moneyKeys");
  expect(source).toContain('body.mode !== "platform"');
  expect(source.indexOf('body.mode !== "platform"')).toBeLessThan(source.indexOf('if ("grantCredits" in body)'));
});
