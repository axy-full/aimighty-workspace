/**
 * What other screens take from Settings (DECISIONS 1): the spending rules, read once, the same everywhere.
 * The control room's Approvals (stream 8) and the phone (stream 10) show them read-only, with a link here.
 */
export { useSpendingRules, type SpendingRules } from "./rules/spending";
export { spendingLines, type SpendingLines } from "./rules/spending-words";
/** Where "Edit in Settings › Spending rules ›" goes. Until Spending rules is drawn, it opens today's page (lib/shell/settings.ts). */
export { sectionTarget } from "@/lib/shell/settings";
