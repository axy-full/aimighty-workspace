/** Optional campaign context; empty values are valid while the brief is drafted. */
export type MarketingBrief = {
  objective: string;
  offer: string;
  audience: string;
  channels: string[];
  tone: string;
  constraints: string;
};

export const MARKETING_BRIEF_LIMITS = {
  objective: 2000,
  offer: 3000,
  audience: 2000,
  channels: 12,
  channel: 80,
  tone: 1000,
  constraints: 3000,
} as const;
