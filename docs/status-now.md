# Status now: 7 October 2026, 15:00 IST, Release 1 on the VPS

Governing scope: `docs/particl-sow.md` (v2). Laptop handover: `docs/HANDOVER.md` on branch `ops/handover-2026-10-06`. Thursday 8 Oct: merge train on the owner's "go". Friday 9 Oct: demo.

**Integration preview:** `release/1` (draft #546) = 99ac9225. The preview runs on the staging databases; the owner is signed in (house workspace).
**D0 review page:** version 3 published; sign-off YES once items a–e are done (a, b, d done; c in; e is the owner's signed-in price check).

## In `release/1` since 13:00
Each reviewed first (Opus for money, sign-in and tenancy).
- Site routing: outside links open Settings in the app; `/workspace` moves with a 307; `/business` and `/viral` stay 308.
- Preview setup step: preview-only, staging-only; a set-your-password link for the platform owner; creates nothing.
- Pipelines: Cinema Studio is not offered and is refused at save, quote and approve.
- "Show me looks" is always priced (outline style too); the Cinema row hover shows dollars on desktop.
- Q15: the old-design browser specs are deleted; three live-route lost-reply tests are kept in their own file.
- Sample mark: an owner or admin lifts it for one approved Atomik run (always Ask); it comes back when the run ends, at 2 h, or when put back.

## In flight
| Branch | State |
|---|---|
| `fix/r1-platform-owner-private` | Review FAIL (stored names; Team row); reworking. The one-off rewrite of old records waits for the owner's yes |
| 3D blocking B | PASS; waits on Q7 |

## Waiting on the owner
1. The signed-in price check on the preview: Motion transfer and Object swap at 6 s, 720p (about 62 cr).
2. Does Preview run with mocked engines, or with no engine keys?
3. Sample lift: allow the plan's fixes after the last take lands, or end the lift at once (today)?
4. Platform-owner privacy: yes or no to a one-off, dry-run-first rewrite of old records in client workspaces.
5. Customer test 3 (an old-shell test, skipped): delete it?

## Machine
CPU 14:11–14:41: average 38%, peak 70%, never above 80%. Two heavy jobs at a time at low priority; full suites run in CI.
