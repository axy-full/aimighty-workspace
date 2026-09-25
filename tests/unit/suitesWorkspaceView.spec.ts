import { test, expect } from "@playwright/test";
import { cleanRule } from "../../lib/approvalRule";
import { APPROVAL_OPTIONS, AT_CAP_OPTIONS, CAP_WARN_OPTIONS, EDIT_FORMAT_OPTIONS, settingProblem } from "../../lib/settingValues";
import { withoutVendorCost } from "../../lib/analyticsRedact";
import {
  auditEntries, checkoutUrl, connectionOutcome, consumerAuthorizeUrl, keyStatus, packLine, planLine, sessionRows,
  statementCsvHref, statementHref, statementMonthsOf, twoStepLine, usageRows,
} from "../../lib/shell/workspace-view";

/*
 * Suites › Workspace reads the routes that already serve each tab. These pin
 * the tab to each route's REAL answer (the audit found mocks that had drifted
 * from it) and the settings route to the vocabulary its readers understand.
 */

test("Cost approval offers only rules the gate enforces, and the settings route refuses the rest", () => {
  /* Every option survives cleanRule unchanged: none is silently read as "anyone". */
  for (const [value] of APPROVAL_OPTIONS) expect(cleanRule(value)).toBe(value);
  expect(APPROVAL_OPTIONS.map(([v]) => v)).toEqual(["anyone", "cap", "producer"]);
  for (const [value] of APPROVAL_OPTIONS) expect(settingProblem("approvalRule", value)).toBeNull();
  /* What the old Suites select saved. */
  expect(settingProblem("approvalRule", "always")).toBe("Choose anyone, cap or producer.");
  expect(settingProblem("approvalRule", "never")).not.toBeNull();
  /* Edits and extensions come back as mp4 or mov; WebM was never read. */
  expect(EDIT_FORMAT_OPTIONS.map(([v]) => v)).toEqual(["mp4", "mov"]);
  expect(settingProblem("editOutputFormat", "webm")).not.toBeNull();
  expect(settingProblem("editOutputFormat", "mov")).toBeNull();
  for (const [value] of AT_CAP_OPTIONS) expect(settingProblem("atCap", value)).toBeNull();
  expect(settingProblem("atCap", "pause")).not.toBeNull();
  for (const [value] of CAP_WARN_OPTIONS) expect(settingProblem("capWarnPct", value)).toBeNull();
  expect(settingProblem("capWarnPct", "75")).toBeNull();
  for (const bad of ["0", "101", "", "8.5", "eighty"]) expect(settingProblem("capWarnPct", bad)).not.toBeNull();
  /* Keys without a fixed vocabulary are the route's other checks' business. */
  expect(settingProblem("namingTemplate", "{project}_{shot}")).toBeNull();
});

test("a credit workspace's analytics carry credits and no vendor dollars", () => {
  const payload = {
    scope: { projectId: "all", days: 0 },
    totals: { generations: 3, spend: 1.88, credits: 29, promptSpend: 0.01, renderMs: 1000 },
    credit: { toppedUp: 500, spentAllTime: 12.5 },
    byProject: [{ id: "p1", name: "One", n: 3, spend: 1.88, credits: 29 }],
    byModel: [{ model: "m", label: "M", n: 3, spend: 1.88, credits: 29 }],
    byDay: [{ day: 0, n: 3, spend: 1.88, credits: 29 }],
    patterns: { avgPromptLength: 40 },
  };
  const out = withoutVendorCost(payload);
  expect(JSON.stringify(out)).not.toMatch(/"spend"|"promptSpend"|"credit"|toppedUp|spentAllTime/);
  expect(out.totals).toEqual({ generations: 3, credits: 29, renderMs: 1000 });
  expect(out.byProject[0]).toEqual({ id: "p1", name: "One", n: 3, credits: 29 });
  expect(out.byDay[0]).toEqual({ day: 0, n: 3, credits: 29 });
  expect(out.scope).toEqual(payload.scope);
  expect(out.patterns).toEqual(payload.patterns);
  /* The input is left as it was. */
  expect(payload.totals.spend).toBe(1.88);
});

test("statements: months are objects from the route, and a month opens the printable page", () => {
  const body = { months: [{ month: "2026-09", takes: 14 }, { month: "2026-08", takes: 2 }] };
  expect(statementMonthsOf(body)).toEqual([{ month: "2026-09", takes: 14 }, { month: "2026-08", takes: 2 }]);
  /* The shape the old tab assumed renders nothing rather than crashing React. */
  expect(statementMonthsOf({ months: ["2026-09"] })).toEqual([]);
  expect(statementMonthsOf({ months: [{ month: "Sept" }] })).toEqual([]);
  expect(statementMonthsOf(null)).toEqual([]);
  expect(statementHref("2026-09")).toBe("/statements/2026-09");
  expect(statementCsvHref("2026-09")).toBe("/api/statements?month=2026-09&format=csv");
});

test("the plan line reads BillingSubscription (planId), not a `plan` field", () => {
  const plans = [{ id: "studio", label: "Studio" }, { id: "agency", label: "Agency" }];
  expect(planLine(plans, null)).toBe("No plan on record");
  expect(planLine(plans, { planId: "studio", status: "active", currentPeriodEnd: Date.UTC(2026, 9, 1) })).toBe("Studio plan · active · renews Oct 1");
  /* Seconds, as a card provider stores them. */
  expect(planLine(plans, { planId: "agency", status: "active", currentPeriodEnd: Date.UTC(2026, 9, 1) / 1000, cancelAtPeriodEnd: true })).toBe("Agency plan · active · ends Oct 1");
  expect(planLine(plans, { planId: "custom", status: "trialing" })).toBe("custom plan · trialing");
  expect(planLine(plans, { plan: "studio" } as never)).toBe("No plan on record");
});

test("packs read as the top-up screen writes them; checkout leaves only for https", () => {
  expect(packLine({ id: "team", label: "Team", credits: 2000, bonus: 200, total: 2200, usd: 200 })).toBe("2,200 cr · $200 · 200 free");
  expect(packLine({ id: "starter", label: "Starter", credits: 500, bonus: 0, total: 500, usd: 50 })).toBe("500 cr · $50");
  expect(checkoutUrl("https://pay.example/c/1", "https://particl.example")).toBe("https://pay.example/c/1");
  expect(checkoutUrl("/pay/1", "https://particl.example")).toBe("https://particl.example/pay/1");
  expect(checkoutUrl("javascript:alert(1)", "https://particl.example")).toBeNull();
  expect(checkoutUrl("http://pay.example", "https://particl.example")).toBeNull();
  expect(checkoutUrl(undefined, "https://particl.example")).toBeNull();
});

test("usage: a credit workspace reads creditUsage().byModel and spentCredits; the studio's own reads its vendors", () => {
  const credit = usageRows({
    unit: "credits", spentCredits: 312,
    byModel: [{ model: "seedance", label: "Seedance 2.5", n: 6, credits: 240 }, { model: "nb2", label: "Nano Banana 2", n: 9, credits: 72 }],
    vendors: [{ id: "byteplus", label: "BytePlus" }],
  });
  expect(credit).toEqual({ unit: "cr", total: 312, rows: [{ id: "seedance", label: "Seedance 2.5", n: 6, amount: 240 }, { id: "nb2", label: "Nano Banana 2", n: 9, amount: 72 }] });
  /* The old tab's two branches, both empty for this shape, were the 0 cr bug. */
  expect(usageRows({ unit: "credits", byModel: [{ model: "m", n: 1, credits: 5 }] }).total).toBe(5);
  const legacy = usageRows({ vendors: [{ id: "byteplus", label: "BytePlus", models: [{ model: "seedance", label: "Seedance", n: 2, spend: 3.5 }] }] });
  expect(legacy).toEqual({ unit: "$", total: 3.5, rows: [{ id: "byteplus/seedance", label: "Seedance · BytePlus", n: 2, amount: 3.5 }] });
  expect(usageRows(null)).toEqual({ unit: "cr", rows: [], total: 0 });
});

test("engine keys say whose key a render uses, by the workspace's mode", () => {
  expect(keyStatus("platform", false)).toEqual({ label: "platform key", canConnect: true });
  expect(keyStatus("platform", true)).toEqual({ label: "connected", canConnect: true });
  /* On its own keys, a vendor it has not added is unrouted (lib/vendorKeys.ts returns null). */
  expect(keyStatus("own", false)).toEqual({ label: "not connected", canConnect: true });
  /* The studio's own workspace runs on the deployment; its keys route refuses a Connect. */
  expect(keyStatus("legacy", false)).toEqual({ label: "deployment key", canConnect: false });
  expect(keyStatus("legacy", true)).toEqual({ label: "deployment key", canConnect: false });
});

test("the account connection opens only the account's own authorize page, and its outcome is said", () => {
  expect(consumerAuthorizeUrl("https://clerk.higgsfield.ai/oauth/authorize?state=x")).toBe("https://clerk.higgsfield.ai/oauth/authorize?state=x");
  for (const bad of ["https://evil.example/oauth/authorize", "https://clerk.higgsfield.ai/other", "https://u:p@clerk.higgsfield.ai/oauth/authorize", "javascript:alert(1)", 42]) expect(consumerAuthorizeUrl(bad)).toBeNull();
  expect(connectionOutcome(null)).toBeNull();
  expect(connectionOutcome("connected")).toEqual({ ok: true, line: "Account connected." });
  expect(connectionOutcome("authorization_denied")?.ok).toBe(false);
  expect(connectionOutcome("invalid_state")).toEqual({ ok: false, line: "The connection was not completed. Connect again from this workspace." });
});

test("security reads readAccountSecurity's fields: enabled, requiredWorkspaces and each session's label", () => {
  const body = {
    enabled: true, requiredWorkspaces: [{ id: "w1", name: "One" }], recoveryCodesRemaining: 8,
    sessions: [{ id: "s1", current: true, label: "Chrome on macOS", createdAt: 1_000, expiresAt: 9_000 }, { id: "s2", current: false, label: "Safari on iPhone", createdAt: 2_000, expiresAt: 9_000 }],
  };
  expect(twoStepLine(body)).toBe("On · required by a workspace");
  expect(twoStepLine({ enabled: false, requiredWorkspaces: [] })).toBe("Off");
  expect(twoStepLine({ enabled: false, requiredWorkspaces: [{ id: "a", name: "A" }, { id: "b", name: "B" }] })).toBe("Off · required by 2 workspaces");
  /* The fields the old tab read (mfa) do not exist. */
  expect(twoStepLine({ mfa: { enabled: true } } as never)).toBeNull();
  expect(sessionRows(body)).toEqual([{ id: "s1", label: "This browser", since: 1_000 }, { id: "s2", label: "Safari on iPhone", since: 2_000 }]);
  expect(auditEntries({ events: [{ id: "e1", action: "member.updated", createdAt: 5 }, { id: "e2", action: "unknown.thing", createdAt: 4 }] }, { "member.updated": "Changed member access" }))
    .toEqual([{ id: "e1", label: "Changed member access", at: 5 }, { id: "e2", label: "unknown.thing", at: 4 }]);
  expect(auditEntries({ error: "Admins only" }, {})).toEqual([]);
});
