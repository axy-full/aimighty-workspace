"use client";
import type { CSSProperties } from "react";
import { fmtCredits } from "@/lib/price";
import { useLowCredit } from "@/lib/v12/useLowCredit";
import { useGoSettings } from "@/components/graphite/settings/navigate";

/**
 * The header's low-credit chip (docs/redesign/inventory.md § 5.1, § 5.7; prototype L53).
 *
 * Shown only when the balance is below 20% of the plan's credits (lib/v12/lowCredit.ts, decision 5); never in the house
 * workspace, which pays in dollars. Its hover names the balance; a click opens Settings › Credits & billing, which for
 * now is today's Plan & credits screen. The header (item A2) places it between Activity and the avatar.
 *
 * `balance`: the live balance, when the header has it (useAccount). `onOpen`: where a click goes, when the header routes
 * Credits & billing itself (item B2).
 */
export function LowCreditChip({ balance, onOpen }: { balance?: number | null; onOpen?: () => void }) {
  const rule = useLowCredit(balance);
  const goSettings = useGoSettings();
  if (!rule.low || rule.balance === null) return null;
  return <LowCreditChipView balance={rule.balance} onOpen={onOpen ?? (() => goSettings("credits"))} />;
}

/** The chip alone, with no hooks: what LowCreditChip draws once the rule says low. */
export function LowCreditChipView({ balance, onOpen }: { balance: number; onOpen: () => void }) {
  const hover = lowCreditHover(balance);
  return (
    <button type="button" className="v12-low-credit" data-testid="v12-low-credit" title={hover} aria-label={`Low on credits. ${hover}`}
      onClick={(event) => { event.stopPropagation(); onOpen(); }} style={CHIP}>
      <span aria-hidden="true" style={DOT} />
      Low on credits · Top up
    </button>
  );
}

/** "Balance 60 cr · open Credits & billing" (inventory § 4.3). */
export const lowCreditHover = (balance: number): string => `Balance ${fmtCredits(balance)} · open Credits & billing`;

/* Prototype L53: 32 h, padding 0 12, gap 8, radius 999, orange hairline at 50%, 13/500, a 7 px orange dot. */
const CHIP: CSSProperties = {
  flex: "none", whiteSpace: "nowrap", height: 32, display: "flex", alignItems: "center", gap: 8, padding: "0 12px",
  border: "1px solid rgba(255, 159, 10, 0.5)", borderRadius: 999, background: "transparent", color: "var(--gx-text)",
  fontFamily: "inherit", fontSize: 13, fontWeight: 500, cursor: "pointer",
};
const DOT: CSSProperties = { width: 7, height: 7, borderRadius: "50%", background: "var(--gx-waiting)", flex: "none" };
