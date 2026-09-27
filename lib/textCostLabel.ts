import { usd } from "./format";

/**
 * The cost line under a finished paid-text run (an idea written, a scene
 * rewritten, a scene broken into shots), from what the route answered
 * (lib/textRunCost.ts): the credits the ledger billed on a credit workspace,
 * the vendor's dollars only for one on its own keys, and nothing when the
 * ledger has not settled — never a vendor dollar figure dressed as credits.
 */
export type TextRunReply = { credits?: number | null; costUsd?: number | null };

export function textCostLabel(money: { inCredits: boolean; price: (n: number) => string }, reply: TextRunReply): string | null {
  if (typeof reply.credits === "number" && Number.isFinite(reply.credits)) return money.price(reply.credits);
  if (!money.inCredits && typeof reply.costUsd === "number" && Number.isFinite(reply.costUsd)) return usd(reply.costUsd, 3);
  return null;
}
