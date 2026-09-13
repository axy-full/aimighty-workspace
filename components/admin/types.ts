import type { PlanDef, PlanId } from "@/lib/plans";
import type { ProviderId } from "@/lib/providers";

/**
 * What the desk reads (SOW surfaces board 12h; the shared contract's item
 * G). Every field the v1 routes answered is still here; the fields the
 * board added are optional, so the desk renders its blocks from whatever
 * the deployment answers and never crashes on a route that is a version
 * behind.
 */
export type Cycle = { key: string; start: number; end: number };
export type Totals = { engineCostUsd: number; billedCredits: number; marginPct: number | null; grantsUsd: number; committedUsd: number; grantBudgetUsd: number | null };
export type Grant = { credits: number; usdEach: number; days: number };
export type QueueRow = { id: string; kind: "request" | "invite"; who: string; email: string; what: string; when: number; code: string | null; expiresAt: number | null };
export type Studio = {
  id: string; name: string; slug: string; tier: string; internal: boolean; suspended: boolean; flagged: boolean;
  engineCostUsd: number; billedCredits: number; marginPct: number | null; share: number; overShare: boolean; underMargin: boolean;
  note: string | null; multiplier: number;
};

export type Ws = {
  id: string; slug: string; name: string; legacy: boolean; platformKeys: boolean; allowanceUsd: number | null; gatewayKey: boolean;
  credits: { granted: number; used: number; balance: number } | null; createdAt: number; owner: { email: string; name: string } | null; members: number;
  spend30: { jobs: number; failed: number; running: number; engineCostUsd: number; billedCredits: number; marginUsd: number } | null;
  grants: { paid: number; free: number };
  suspended: boolean; suspendedReason: string | null; flagged: boolean; flagNote: string | null;
  limits: { concurrency: number | null; rendersPerHour: number | null; storageGb: number | null };
  internalTest?: boolean;
  internal?: boolean;
  planId: PlanId | null;
};

export type Admin = {
  ready: boolean; mail: boolean;
  invites: { code: string; email: string; name: string; note: string; createdAt: number; expiresAt: number; sentAt: number | null; sendCount: number }[];
  requests: { id: string; name: string; email: string; note: string; mailed: boolean; createdAt: number }[];
  platformKeysByDefault: boolean; defaultAllowanceUsd: number | null; gatewayMint: boolean;
  creditUsd: number; signupCredits: number;
  plans: PlanDef[];
  concurrency: { byEngine: { engine: string; peak: number; at: number; jobs: number }[]; overall: { peak: number; at: number }; days: number } | null;
  workspaces: Ws[];
  /* Board 12h (contract G). */
  cycle?: Cycle;
  totals?: Totals;
  grant?: Grant;
  queue?: QueueRow[];
  studios?: Studio[];
};

export type Health = { engine: string; model: string; jobs: number; failed: number; running: number; failRate: number; avgMs: number | null; maxMs: number | null; engineCostUsd: number };
export type Provider = {
  id: ProviderId; label: string; short: string; models: string[]; configured: boolean; on: boolean; reason: string | null;
  jobs7d: number; failed7d: number; failRate7d: number; running: number; peak30d: number; concurrent: number | null; room: number | null; marginPct7d: number | null;
};
export type EnginesView = { day: Health[]; week: Health[]; providers?: Provider[] };

export type Layer = {
  setup: Record<string, string | null | undefined>;
  starter: { name: string; code: string; description: string; shots: { code: string; title: string; description: string; planned: number; setup: Record<string, string>; cast: string[] }[]; cast: { name: string; kind: "character" | "location" | "prop" | "style"; description: string }[] };
  rules: { id: string; text: string; scope: string; apply: "writer" | "prompt"; on: boolean }[];
  caps: { defaultCapCredits: number | null; signupCredits: number | null; warnPct: number; concurrency: number; rendersPerHour: number; storageGb: number; grantBudgetUsd?: number | null };
  models: { video: string; image: string; text?: Record<string, string> };
};
export type LayerSummary = { setupRows: number; rules: number; recipes: number; starter: string; capCredits: number | null; warnPct: number; grantBudgetUsd: number | null };
export type LayerView = { layer: Layer; stored: string[]; defaults: Layer; cameraBank: { kind: string; value: string; label: string; module: string }[]; summary?: LayerSummary };
