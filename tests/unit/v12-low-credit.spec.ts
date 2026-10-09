import { test, expect } from "@playwright/test";
import { LOW_CREDIT_PERCENT, lowCredit } from "../../lib/v12/lowCredit";
import { DEFAULT_PLANS, planById } from "../../lib/plans";
import { signupCredits } from "../../lib/creditTerms";
import { LowCreditChipView, lowCreditHover } from "../../components/v12/shell/LowCreditChip";

/**
 * The low-credit rule (docs/redesign-plan.md, decision 5; lib/v12/lowCredit.ts): low below 20% of the plan's included
 * credits for the cycle; on Invite (no included credits) the base is the welcome grant; never for the house workspace,
 * which pays in dollars. The plans and the grant are read from the code that defines them, never typed here.
 */

const studio = planById(DEFAULT_PLANS, "studio")!.includedCredits;
const invite = planById(DEFAULT_PLANS, "invite")!.includedCredits;
const welcome = signupCredits();
const at = (base: number, share: number) => (base * share) / 100;

test("the rule is 20% of the base", () => {
  expect(LOW_CREDIT_PERCENT).toBe(20);
});

test("Studio: low below 20% of the cycle's included credits, not at exactly 20%", () => {
  expect(studio).toBeGreaterThan(0);
  const edge = at(studio, LOW_CREDIT_PERCENT);
  const rule = (balance: number) => lowCredit({ balance, planIncludedCredits: studio, welcomeGrant: welcome, paysInCredits: true });
  expect(rule(edge)).toEqual({ low: false, remainingPct: 20, threshold: edge, base: studio });
  expect(rule(edge - 1).low).toBe(true);
  expect(rule(edge - 0.1).low).toBe(true);
  expect(rule(edge + 0.1).low).toBe(false);
  expect(rule(studio).low).toBe(false);
  expect(rule(studio).remainingPct).toBe(100);
  expect(rule(0)).toEqual({ low: true, remainingPct: 0, threshold: edge, base: studio });
  /* A balance in overdraft is low and reads 0%, never negative. */
  expect(rule(-5)).toMatchObject({ low: true, remainingPct: 0 });
  /* A pack bought on top keeps the balance above the base: not low. */
  expect(rule(studio * 3).low).toBe(false);
});

test("Invite: no included credits, so the base is the welcome grant; exactly 20% of it is not low", () => {
  expect(invite).toBe(0);
  expect(welcome).toBeGreaterThan(0);
  const edge = at(welcome, LOW_CREDIT_PERCENT);
  const rule = (balance: number) => lowCredit({ balance, planIncludedCredits: invite, welcomeGrant: welcome, paysInCredits: true });
  expect(rule(edge)).toEqual({ low: false, remainingPct: 20, threshold: edge, base: welcome });
  expect(rule(edge - 1).low).toBe(true);
  expect(rule(welcome).low).toBe(false);
});

test("the house workspace pays in dollars: never low, whatever the figures", () => {
  for (const balance of [0, -10, 1, null])
    expect(lowCredit({ balance, planIncludedCredits: studio, welcomeGrant: welcome, paysInCredits: false })).toEqual({ low: false, remainingPct: null, threshold: null, base: null });
});

test("no base or no balance means no warning, never a guessed one", () => {
  expect(lowCredit({ balance: 0, planIncludedCredits: 0, welcomeGrant: 0, paysInCredits: true }).low).toBe(false);
  expect(lowCredit({ balance: 0, planIncludedCredits: undefined, welcomeGrant: undefined, paysInCredits: true }).low).toBe(false);
  expect(lowCredit({ balance: 0, planIncludedCredits: Number.NaN, welcomeGrant: null, paysInCredits: true }).low).toBe(false);
  expect(lowCredit({ balance: null, planIncludedCredits: studio, welcomeGrant: welcome, paysInCredits: true })).toMatchObject({ low: false, remainingPct: null, base: studio });
});

test("a base that does not divide evenly still tips exactly at 20%", () => {
  const base = 333; /* 20% is 66.6 */
  expect(lowCredit({ balance: 66.6, planIncludedCredits: base, welcomeGrant: welcome, paysInCredits: true }).low).toBe(false);
  expect(lowCredit({ balance: 66.5, planIncludedCredits: base, welcomeGrant: welcome, paysInCredits: true }).low).toBe(true);
});

/** The element LowCreditChipView returns, read as data (this runner compiles JSX to plain objects). */
function shown(balance: number, onOpen: () => void) {
  const root = LowCreditChipView({ balance, onOpen }) as unknown as { type: string; props: Record<string, unknown> };
  const text = (node: unknown): string => {
    if (node == null || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    return text((node as { props?: { children?: unknown } }).props?.children);
  };
  return { type: root.type, props: root.props, text: text(root.props.children).trim() };
}

test("the chip reads as the prototype, names the balance on hover, and a click opens Credits & billing", () => {
  let opened = 0;
  const balance = at(welcome, 10);
  const chip = shown(balance, () => { opened += 1; });
  expect(chip.type).toBe("button");
  expect(chip.text).toBe("Low on credits · Top up");
  expect(chip.props.title).toBe(`Balance ${balance.toLocaleString("en-US")} cr · open Credits & billing`);
  expect(chip.props.title).toBe(lowCreditHover(balance));
  expect(lowCreditHover(1240)).toBe("Balance 1,240 cr · open Credits & billing");
  const style = chip.props.style as Record<string, unknown>;
  expect(style).toMatchObject({ height: 32, borderRadius: 999, fontSize: 13, fontWeight: 500, border: "1px solid rgba(255, 159, 10, 0.5)" });
  (chip.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: () => {} });
  expect(opened).toBe(1);
});
