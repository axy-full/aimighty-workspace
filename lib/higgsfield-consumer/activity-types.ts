/** Approved local quotes, never a provider invoice, live balance or currency conversion. */
export type ConsumerActivityState =
  "completed" | "pending" | "uncertain" | "failed";
export type ConsumerActivityTotals = Record<
  ConsumerActivityState,
  { jobs: number; quoteCredits: number }
>;
export type ConsumerCreditActivity = {
  creditUnit: "higgsfield_credits";
  basis: "approved_quotes";
  scope: "own_account";
  totals: ConsumerActivityTotals;
  projects: {
    draftId: string;
    name: string | null;
    available: boolean;
    totals: ConsumerActivityTotals;
  }[];
  projectLimit: number;
  projectsTruncated: boolean;
};
