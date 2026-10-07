# Status now: 7 October 2026, 10:20 IST, Release 1 on the VPS

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. Thursday 8 Oct: merge train on the owner's "go". Friday 9 Oct: demo.

**Integration preview:** `release/1` (draft #546) = 8e0002f8 → https://particlstudio-git-release-1-akshayzigzag-filmscoms-projects.vercel.app/suites. Sign-in there waits on the owner's Preview database key (steps sent in chat).
**D0 review page:** private artifact, sent to the owner in chat; republished when the fixes below land.

## In `release/1` today
Lane 3 (Edit & Sound, empty boards, posts), sample no-spend 2, Cinema hidden, CI fixes F6, the orphan sweep (23 unused files), a Transcribe test fix, `sharp` 0.35.5 (#560), main's docs, 3D blocking part A (reviewed PASS), CI path and spend-audit fixes. Unit on this head: 3,739 passed, 0 failed. CI run 37571385093 in progress; `core` fails on the sign-up rehearsal (being retargeted to invite-only).

## Reviews today
| Branch | Verdict | Next |
|---|---|---|
| #540 Cinema hold | PASS (delta) | Merge `release/1` in, fix N1, then the Cinema browser tests; delta review |
| #558 security | PASS; lows fixed at 43b5ac7e | Delta review running; then the owner's yes |
| #556 money states | PASS at 59a37536 (option b) | Fix 4 lows; owner's yes on 18 lines and Q11 = (b) |
| 3D blocking A / B | PASS / PASS | A merged; B waits on Q7 |
| Sample paid-off | FAIL on one UI medium (priced controls shown) | UI fix running; delta review |

## D0 list (owner, 7 Oct)
| # | Item | Branch | State |
|---|---|---|---|
| 1 | Public site copy and screenshots | `fix/r1-site-shell` | Copy done; 5 old screenshots to replace (all show old names) |
| 2 | Motion transfer price | — | 12 cr is the mock's placeholder; the real figure needs the API-key price check |
| 3 | Atomik thinking figure | — | One formula; 14 cr for a credit workspace (9 cr is the same cost without the multiplier) |
| 4 | One filled button | — | Next |
| 5 | Phone Record ids and loading lines | — | Next |
| 6 | React Flow attribution | `fix/r1-hide-flow-attribution` | Done; reviewer next |
| 7 | HOME/BOARD tag | — | In the handoff (README §1, "particl mark + suite pill"); kept |
| 8 | ⌘K empty list | `fix/r1-palette-empty` | Done; reviewer next |
| 9 | D0 fixes 6, 8, 9 (Make) | `fix/r1-make-d0` | In progress |

## Waiting on the owner
1. Preview database key (Vercel Preview only; steps in chat).
2. #556: Q11 = (b) and the 18 lines. #558: the 10 lines and two questions.
3. Q15 (old tests: list coming), Q14, Q3, Q10.
4. The public /studio page still describes ten stages: rewrite now, or with Guest Home?

## Machine
Browser lanes capped at 2 at a time (memory). Higgsfield connector tools are denied in Claude Code's own settings on the VPS; app code untouched.
