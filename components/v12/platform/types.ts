import type { PlanDef, PlanId } from "@/lib/plans";

/** What GET /api/admin/invites answers (app/api/admin/invites/route.ts): the desk's one big read, shared by Who can join and All workspaces. */
export type AdminInvite = { code: string; email: string; name: string; note: string; createdAt: number; expiresAt: number; sentAt: number | null; sendCount: number };
export type AdminRequest = { id: string; name: string; email: string; note: string; mailed: boolean; createdAt: number };
export type AdminWorkspace = {
  id: string; slug: string; name: string; legacy: boolean; house?: boolean;
  credits: { granted: number; used: number; balance: number } | null;
  createdAt: number; deletedAt: number | null; owner: { email: string; name: string } | null; members: number;
  spend30: { jobs: number; billedCredits: number; engineCostUsd: number; atCost?: boolean } | null;
  suspended: boolean; suspendedReason: string | null;
  planId: PlanId | null;
};
export type AdminDesk = {
  ready: boolean; mail: boolean;
  invites: AdminInvite[];
  requests: AdminRequest[];
  plans: PlanDef[];
  workspaces: AdminWorkspace[];
};
