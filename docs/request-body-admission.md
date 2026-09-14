# Bounded request admission

Account forms, workbench Atomik requests, pipeline creation/actions and complete production saves share a streaming UTF-8 reader. It measures actual bytes before decoding or appending, rejects an oversized declared body without pulling it, and stops/cancels when chunked or under-declared input crosses the limit. Cancellation failure cannot replace or delay the 413 response. Invalid UTF-8, interrupted streams and malformed JSON produce 400 responses; pipeline JSON must be an object.

| Handler | Maximum bytes |
| --- | ---: |
| Account forms, including password/MFA/workspace-policy actions | 8,192 |
| Workbench Atomik | 20,000 |
| Pipeline creation | 1,000,000 |
| Pipeline actions | 4,096 |
| Complete private production saves and edit-version requests | 3,500,000 |

Valid input at the byte boundary is preserved, including multibyte characters split between chunks. The request is never silently shortened. Source uploads continue through their separate media/chunk admission paths; these JSON limits do not restrict a retained screenplay file to the Atomik prompt limit.

The helper bounds application buffering for these handlers. An upstream platform may already have buffered a request, and its transport limits/timeouts remain relevant. This change does not establish bounds for every legacy JSON endpoint, slow-client protection or sustained traffic capacity.

Regression checks exercise the real handler admission with downstream spies, exact byte boundaries, Unicode, absent/false length headers, an unread oversized tail, failed cancellation, invalid JSON/UTF-8 and interrupted streams. Existing screenplay tests ensure the complete source remains intact. Full browser flows cover valid account, production and pipeline requests separately.
