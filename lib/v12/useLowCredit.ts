"use client";
import { useMemo } from "react";
import { useSession } from "@/lib/session";
import { lowCredit, type LowCredit } from "./lowCredit";

/**
 * The low-credit rule for this session's workspace (lib/v12/lowCredit.ts). `balance` is the live one when the caller has
 * it (the header's useAccount poll of /api/me); without it, the balance the page loaded with. The base is the session's.
 */
export function useLowCredit(balance?: number | null): LowCredit & { balance: number | null } {
  const { credits, rates } = useSession();
  const live = typeof balance === "number" && Number.isFinite(balance) ? balance : credits?.balance ?? null;
  return useMemo(() => ({
    ...lowCredit({
      balance: live,
      planIncludedCredits: credits?.planIncludedCredits,
      welcomeGrant: credits?.welcomeGrant,
      paysInCredits: Boolean(credits) && rates.unit === "cr",
    }),
    balance: live,
  }), [live, credits, rates.unit]);
}
