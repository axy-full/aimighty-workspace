# Astra active jobs and historical timeout recovery

Affirmative fal queued/running replies no longer fail solely because the job was created over one hour ago. The job stays active, retains its existing reservation and provider handle, and receives a delay notice. No second provider request is submitted. A confirmed provider rejection remains terminal under the existing failure billing policy.

A narrow bridge collects Astra jobs already failed by the former one-hour ceiling. Scheduled reconciliation includes candidate rows, and direct job polling and the maintenance recovery drain pass them to the same collector. All of these guards are required:

- Astra video on fal, undeleted, failed with the exact former local-timeout error, with no stored/source output or recorded final cost.
- The saved endpoint and request ID match the original produced submission receipt, with the permanent paid claim present.
- The tenant settlement is delivered, identifies that same video/model/provider/job, and records an unknown-cost failure.
- The platform meter, existing debit and accepted recovery intent agree on that job and workspace. The retained funding source matches the credentials used to poll.

Collection uses the existing five-minute Astra lease. The original submitted params and settlement receipt are checked again after polling and bound to the final tenant write. Changed leases, receipts, sources or quote settings reject stale collection. No meter status, debit or reservation is reset while waiting. The original job receives the delivered media and actual verified output metadata only after successful collection. The original funding values and final debit are persisted in its outbox, checked inside the billing transaction, and replayed idempotently after a crash. Changed pricing cannot increase the final debit above the original reservation; optional client quote fields are not required for historical eligibility.

## Operational limits

Historical timeout rows retain their old failed label while the provider is still active. Their already-failed meter does not regain a pending count or occupy an application concurrency slot. This deliberately avoids silently reopening old reservations or changing capacity accounting; these rows require operational attention until collected. New jobs kept active by this fix retain normal pending and capacity accounting.

Unrecognized failures, missing or inconsistent receipts/funding, changed credentials, deleted jobs and confirmed failures are not automatically revived. A funding mismatch during outbox delivery leaves the output saved and settlement pending for reconciliation. An output that exceeds the original reservation or fails media inspection remains unsettled for reconciliation. A provider outage while collecting an eligible historical row preserves its eligibility.

This is not a general provider recovery migration. The existing six-hour unreachable-provider policy and explicit not-found policy for ordinary active jobs are unchanged. No live provider result, invoice, account or workload capacity has been qualified by these local tests.

## Verification

The focused local suite uses disposable SQLite databases, deterministic provider status stubs, and an actual MP4 fixture. It covers queued/running replies beyond both one- and six-hour ages, late original delivery, scheduled historical discovery, unchanged reservations while waiting, true failure, noneligible historical records, missing optional quote fields, concurrent/stale collectors, lost leases, changed funding/params/outboxes, changed pricing, and durable settlement rejection/retry. The provider render entry point throws during these tests to prohibit resubmission.
