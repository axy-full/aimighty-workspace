# Daily report format (10:30 IST, on the status page)

Owner, 15 Oct 2026, 22:15: "REPORT daily at 10:30: what is live, what the team found, spend so far, what is blocked on me." 22:20: "what merged (PR, head, Opus verdict), what is NEEDS AKSHAY and why, what is blocked on me, spend (should be $0), and anything that broke."

Published on the status page (https://claude.ai/artifact/DtnxW74goSK8ic7MonDnt5). One screen, in this order; each section omitted when empty except 1 and 5.

1. **Production** (always first). Health commit on every hit, errors seen, latency (p50/p95 of /api/health), disk. If anything is wrong: what, since when, and that merging stopped. Never "fixed production".
2. **Blocked on the owner.** Numbered, each with a recommendation and the exact yes/no needed.
3. **Merged into release/1.** Table: PR · head · what it does in one line · Opus verdict · CI run. Merged under the standing yes or with the owner's word (say which).
4. **NEEDS AKSHAY, ready.** Table: PR · head · why it needs the owner (migration / env name / money / sign-in / guard / not on the stack) · Opus verdict · CI.
5. **Spend.** Engine spend since the last report from the house workspace's ledger, against the $500 monthly cap (warning at 80%). Before team testing starts: $0, and "no paid generation ran".
6. **What is live** (on particl.si) per slice, and what the team found (from the feedback board): each item → PR or "not yet".
7. **Slices.** One line each: Slice 1 … 5: done / in progress / waiting, and the next PR.
8. **Broke or slipped.** Incidents, rule slips (lanes or the lead), flaky tests, reverted work.
9. **Housekeeping.** `df -h /`, lanes and what each is on, worktrees left for the owner.

Rules: plain words, numbers with units, no prose where a table works, PR numbers and heads always, nothing invented: if unknown, say "unknown" and how to find out.
