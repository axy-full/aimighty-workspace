"use client";
import { CreditsBilling } from "../CreditsBilling";
import { useGoSettings } from "@/components/graphite/settings/navigate";
import type { WorkspaceAccount } from "@/lib/workspace/data";

/**
 * Workspace settings › Credits & billing (an admin) and Plan (a member, read only). It is the page built for prototype 12's
 * `?view=billing` (components/v12/settings/CreditsBilling.tsx), drawn inside the console: its balance, plan, per-board spend, history
 * and CSV, with Top up opening today's flow unchanged. The plan cards are whatever that page draws.
 */
export function ConsoleBilling({ account, admin, onOpenProject }: { account: WorkspaceAccount | null; admin: boolean; onOpenProject: (id: string) => void }) {
  const go = useGoSettings();
  return <CreditsBilling embedded readOnly={!admin} account={account} onTopUp={() => go("credits", "packs")} onOpenBoard={onOpenProject} />;
}
