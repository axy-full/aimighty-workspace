# Workspace policy read performance

A bounded remote staging rehearsal sent 260 authenticated reads at concurrency 1, 4 and 8, without generation or email. All requests succeeded. At concurrency 8, the overall p95 was 1,366 ms; policy reads had a 1,010 ms median. This is a small single-account read rehearsal, not a sustained traffic or write-capacity claim.

Inspection found that reading workspace policy queued an account/billing write transaction and executed separate session, workspace, ownership, member and factor queries. The read now uses one SELECT. Session expiry, disabled/deleted accounts, enrolled-session factor epoch, selected-workspace fallback, captured scope and actual owner membership are checked from the same statement snapshot. Membership counts use that same snapshot. The result does not include password hashes or factor secrets.

Policy changes and factor changes retain their existing write transactions, password/factor checks, source of authority and audit behavior. The read remains behind tenant/session/MFA/request-scope guards. An invalid session returns 401, changed scope returns 409 and a non-owner returns 403.

Regression checks exercise the real SQL and verify one SELECT, session revocation, fallback selection, lost membership, factor standing and the original policy-enforcement suite. Measure the final deployment again before attributing a latency improvement to this change.
