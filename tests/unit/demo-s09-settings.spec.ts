import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OLD_TAB_TO_SECTION, SETTINGS_BUILT, SETTINGS_FOLDS, SETTINGS_INTERIM, SETTINGS_SCREEN, SETTINGS_SECTIONS,
  applyRows, isBuiltSection, readSettingsOpen, sectionTarget,
} from "../../lib/shell/settings";
import {
  creditPriceLine, creditsWithUsd, inviteLine, memberLine, monthKey, monthLine, monthTotalsOf, peopleMeta, planView, roleChangeable, roleOf,
  topUpLabel, topUpPack,
} from "../../components/graphite/settings/model";
import { capInput, productionLine, ruleValue, spendingLines, type SpendingRules } from "../../components/graphite/settings/rules/spending-words";
import { RIG_AGENT_JOB_CEILING_CREDITS } from "../../lib/workbench/rig-agent-limits";
import { jobApprovalLineCredits } from "../../lib/approvalRule";
import { APPROVAL_OPTIONS, AT_CAP_OPTIONS, CAP_WARN_OPTIONS, settingProblem } from "../../lib/settingValues";
import { creditsText } from "../../lib/shell/price-words";
import { DEFAULT_PLANS } from "../../lib/plans";
import { packs } from "../../lib/packs";

/**
 * Settings in five sections (design/particl-graphite/README.md § 3.5, § 1.2): the ids and rows the shell reads
 * (lib/shell/settings.ts), and every line a section draws held to what the code does, not the design's samples.
 */

test.describe("the Settings contract (lib/shell/settings.ts)", () => {
  test("five sections, in the design's order and words", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual(["Team", "Plan & credits", "Spending rules", "Connections", "Advanced"]);
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(["team", "credits", "rules", "connections", "advanced"]);
  });

  test("a section not drawn yet opens the page that holds it today; a drawn one opens itself", () => {
    for (const { id } of SETTINGS_SECTIONS) {
      const target = sectionTarget(id);
      if (isBuiltSection(id)) expect(target).toEqual({ kind: "section", section: id });
      else expect(target).toEqual(SETTINGS_INTERIM[id]);
    }
    expect(SETTINGS_BUILT).toEqual(["team", "credits", "rules"]);
    expect(sectionTarget("team", "security")).toEqual({ kind: "section", section: "team", open: "security" });
  });

  test("Workspace's seven tabs each have a home (README § 1.2)", () => {
    expect(Object.keys(OLD_TAB_TO_SECTION).sort()).toEqual(["credits", "dashboard", "engines", "general", "people", "security", "usage"]);
    expect(OLD_TAB_TO_SECTION.dashboard).toEqual({ activity: true });
    for (const at of Object.values(OLD_TAB_TO_SECTION)) if ("section" in at && at.open) expect(SETTINGS_FOLDS).toContain(at.open);
  });

  test("`open` reads only a fold Settings has", () => {
    expect(readSettingsOpen("?view=workspace&tab=advanced&open=models")).toBe("models");
    expect(readSettingsOpen("?open=nonsense")).toBeNull();
    expect(readSettingsOpen(new URLSearchParams("tab=team"))).toBeNull();
  });

  test("switch on: old tabs land on their drawn section; undrawn sections on today's page; never a chain", () => {
    const on = (s: string) => applyRows(s, SETTINGS_SCREEN.rows);
    expect(on("?view=workspace&tab=people&project=p1")).toBe("?project=p1&view=workspace&tab=team");
    expect(on("?view=workspace&tab=security")).toBe("?view=workspace&tab=team&open=security");
    expect(on("?view=workspace&tab=usage")).toBe("?view=workspace&tab=credits&open=usage");
    expect(on("?view=workspace&tab=credits")).toBeNull();
    expect(on("?view=workspace&tab=team")).toBeNull();
    expect(on("?view=workspace&tab=rules")).toBeNull();
    expect(on("?suite=atomik&page=budget")).toBe("?view=workspace&tab=rules");
    expect(on("?view=workspace&tab=connections")).toBe("?suite=atomik&page=skills");
    expect(on("?view=workspace&tab=advanced")).toBe("?view=workspace&tab=engines");
    expect(on("?view=workspace&tab=advanced&open=models")).toBe("?suite=atomik&page=models");
    for (const rows of [SETTINGS_SCREEN.rows, SETTINGS_SCREEN.fallback]) {
      for (const row of rows) expect(applyRows(applyRows(row.from, rows)!, rows), `${row.from} lands in one hop`).toBeNull();
    }
  });

  test("switch off: every section opens today's page", () => {
    const off = (s: string) => applyRows(s, SETTINGS_SCREEN.fallback);
    expect(off("?view=workspace&tab=team")).toBe("?view=workspace&tab=people");
    expect(off("?view=workspace&tab=team&open=security")).toBe("?view=workspace&tab=security");
    expect(off("?view=workspace&tab=credits")).toBeNull();
    expect(off("?view=workspace&tab=credits&open=usage")).toBe("?view=workspace&tab=usage");
    expect(off("?view=workspace&tab=rules")).toBe("?suite=atomik&page=budget");
    expect(SETTINGS_SCREEN).toMatchObject({ id: "settings", landed: true, params: ["open"] });
  });
});

test.describe("Team, as the code has it", () => {
  const member = { id: "u2", email: "j@example.test", name: "Jordan Lee", role: "member", standing: "member", permanent: false, disabled: false, locked: true, lastSeen: null, clips: 0 };
  const owner = { ...member, id: "u1", role: "admin", standing: "owner", permanent: true, locked: false };
  test("roles by role, never a person's own limit; the owner's seat never changes", () => {
    expect(roleOf(owner)).toBe("owner");
    expect(roleOf(member)).toBe("member");
    expect(roleChangeable(owner, true)).toBe(false);
    expect(roleChangeable(member, true)).toBe(true);
    expect(roleChangeable(member, false)).toBe(false);
    expect(memberLine(member)).toBe("j@example.test · last seen never · locked");
    expect(inviteLine({ code: "c", email: "r@example.test", name: "Riley", expiresAt: Date.UTC(2026, 9, 9, 12) })).toBe("r@example.test · invited · expires Oct 9");
    expect(peopleMeta({ canSeeRoles: true, users: [owner, member, { ...member, id: "u3", disabled: true }], invites: [{ code: "c", email: "r@example.test", name: "Riley", expiresAt: 1 }] }))
      .toBe("2 on this workspace · 1 invited");
  });
});

test.describe("Plan & credits, as the code has it", () => {
  test("dollars only at the server's rate; none while it is unknown", () => {
    expect(creditPriceLine(0.1)).toBe("1 credit = $0.10");
    expect(creditPriceLine(null)).toBeNull();
    expect(creditsWithUsd(2000, 0.1)).toEqual({ text: "2,000 cr", usd: "$200.00" });
    expect(creditsWithUsd(2000, null)).toEqual({ text: "2,000 cr", usd: null });
  });

  test("this month: what settled, and what running jobs hold (the ledger's own totals)", () => {
    expect(monthKey(Date.UTC(2026, 9, 31, 23, 30))).toBe("2026-10");
    expect(monthTotalsOf({ unit: "usd", totals: { charged: 3 } })).toBeNull();
    const t = monthTotalsOf({ unit: "credits", totals: { jobs: 9, charged: 163, held: 20, notBilled: 1 } })!;
    expect(monthLine(t)).toBe("163 cr settled · 20 cr held");
    expect(monthLine({ ...t, held: 0 })).toBe("163 cr settled");
  });

  test("the plan shows only what the code holds: no feature flags, no invented figure", () => {
    const plans = DEFAULT_PLANS;
    expect(planView(plans, null)).toEqual({ meta: "No plan on record", included: null, renews: null, status: null });
    const v = planView(plans, { planId: "studio", status: "active", currentPeriodEnd: Date.UTC(2026, 10, 1) / 1000 });
    expect(v).toEqual({ meta: "Studio · $49 a month", included: 400, renews: { word: "Renews", date: "1 Nov 2026" }, status: null });
    expect(planView(plans, { planId: "invite", status: "past_due" }).included).toBeNull();
    expect(planView(plans, { planId: "invite", status: "past_due" }).status).toBe("past due");
  });

  test("Top up asks for the smallest pack the platform sells, in its own words", () => {
    const list = packs();
    const first = topUpPack(list)!;
    expect(first.usd).toBe(Math.min(...list.map((p) => p.usd)));
    expect(topUpLabel({ total: 500, usd: 50 })).toBe("Top up · 500 cr · $50");
    expect(topUpPack([])).toBeNull();
  });
});

test.describe("the spending rules, read-only (DECISIONS 1, 10)", () => {
  const base: SpendingRules = { loaded: true, rule: "cap", shotCap: 50, platformLine: 200, mode: "ask", perJobLine: 200, capWarnPct: 80, atCap: "producer", canChange: false };
  test("each line says what the code does", () => {
    const l = spendingLines(base, creditsText);
    expect(l.ruleLine).toBe("Members up to 50 cr a shot; an admin above it.");
    expect(l.platformLineText).toBe("Any job over 200 cr needs a person’s approval, even under Auto.");
    expect(l.modeLine).toBe("Every paid step waits for a person.");
    expect(l.autoLine).toBe("Auto is picked per Board run, for drafts at or under 200 cr.");
    expect(l.budgetLine).toBe("Warn at 80% of a production’s cap · at the cap an admin unlocks it");
    expect(spendingLines({ ...base, rule: "anyone" }, creditsText).ruleLine).toBe("Members render freely.");
    expect(spendingLines({ ...base, rule: "producer" }, creditsText).ruleLine).toBe("A producer signs off on every take.");
    expect(spendingLines({ ...base, platformLine: null, perJobLine: null }, creditsText)).toMatchObject({ platformLineText: null, autoLine: null });
  });

  test("the per-job line Settings shows is the code's: the owner's number is unset, so it is the platform line", () => {
    /* If this fails, the owner gave Board jobs their own line: useSpendingRules must read it rather than the platform line. */
    expect(RIG_AGENT_JOB_CEILING_CREDITS).toBeNull();
    expect(jobApprovalLineCredits(0.1)).toBe(200);
  });
});

test.describe("changing the rules (9.2)", () => {
  const base: SpendingRules = { loaded: true, rule: "cap", shotCap: 50, platformLine: 200, mode: "ask", perJobLine: 200, capWarnPct: 80, atCap: "producer", canChange: true };
  test("the Rule row's value is the cap in credits, or the rule's own word", () => {
    expect(ruleValue(base, creditsText)).toBe("50 cr");
    expect(ruleValue({ ...base, rule: "producer" }, creditsText)).toBe("producer");
    expect(ruleValue({ ...base, rule: "anyone" }, creditsText)).toBe("anyone");
  });
  test("a cap is a whole number of credits; a production's may also be none", () => {
    expect(capInput("40")).toBe(40);
    expect(capInput(" 40 ")).toBe(40);
    for (const bad of ["", "0", "-3", "4.5", "1e3", "abc", "123456789"]) expect(capInput(bad), bad).toBeNull();
    expect(capInput("0", true)).toBe(0);
  });
  test("the settings route takes exactly the values the rules editor offers", () => {
    for (const [id] of APPROVAL_OPTIONS) expect(settingProblem("approvalRule", id)).toBeNull();
    for (const [id] of AT_CAP_OPTIONS) expect(settingProblem("atCap", id)).toBeNull();
    for (const [id] of CAP_WARN_OPTIONS) expect(settingProblem("capWarnPct", id)).toBeNull();
    expect(settingProblem("approvalRule", "always")).not.toBeNull();
  });
  test("each production reads as spent against its cap, in credits", () => {
    expect(productionLine({ id: "p", name: "A", credits: 40, capCredits: 200 }, creditsText)).toEqual({ value: "40 of 200 cr", sub: "160 cr left" });
    expect(productionLine({ id: "p", name: "A", credits: 200, capCredits: 200 }, creditsText)).toEqual({ value: "200 of 200 cr", sub: "at the cap" });
    expect(productionLine({ id: "p", name: "A", credits: 210, capCredits: 200, capUnlocked: true }, creditsText).sub).toBe("unlocked past the cap");
    expect(productionLine({ id: "p", name: "A", credits: 12, capCredits: null }, creditsText).value).toBe("12 cr");
  });
});

test.describe("public-repo and floor checks on Settings' own files", () => {
  const dir = join(__dirname, "../../components/graphite/settings");
  const files = ["SettingsView.tsx", "parts.tsx", "model.ts", "navigate.ts", "use-settings.ts", "index.ts", "settings.css", "team/TeamSection.tsx", "credits/CreditsSection.tsx", "rules/spending.ts", "rules/spending-words.ts", "rules/RulesSection.tsx"];
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  test("no handoff placeholder names, no vendor cost words, no hard-coded credit rate", () => {
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/Maison Aurel|Dune Studies|Northline|Mara Sethi|Iver Lund|\bMira\b|ZigZag/);
      if (!f.endsWith(".css")) expect(text, f).not.toMatch(/engine_cost_usd|costUsd|cost_usd|\bmargins?\(|vendorRates|\bquoted\b/i);
      expect(text, f).not.toMatch(/0\.10?\s*\*|\*\s*0\.10?\b/);
    }
  });
  test("no text under 12 px in the stylesheet", () => {
    const sizes = [...read("settings.css").matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const n of sizes) expect(n).toBeGreaterThanOrEqual(12);
  });
});
