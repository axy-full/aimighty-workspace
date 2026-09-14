# Workspace security history

Settings → Activity is visible to workspace owners and administrators. The API requires a captured account/workspace scope, rejects stale tabs, reads only the selected workspace, and returns private, non-cacheable pages. Both the platform database and the workspace database can own events; a stable timestamp/UUID cursor merges their records without a cross-database transaction.

Each covered mutation writes its receipt inside the same database transaction as the change. If receipt insertion fails, the change rolls back. Database triggers reject UPDATE and DELETE against the history table. This provides append-only application history; an operator with unrestricted database administration can still alter the database or its triggers. An independently retained signed archive is not implemented by these triggers.

Covered changes:

- Session creation, explicit sign-out, and selected workspace changes.
- Password reset (including atomic revocation of previous sessions).
- Team role, enable/disable, unlock and removal.
- Workspace vendor key changes and platform/own-key mode changes.
- Personal API token creation and revocation.
- Client review link creation and revocation.

Events contain generated IDs, actor and target IDs, a fixed action, time, and tightly allowlisted structural details. They never accept arbitrary request metadata, key values, session tokens, prompts, URLs, email addresses or asset contents. Display names are resolved only from the selected workspace's current memberships; removed people retain their identifier without looking up accounts in another workspace. All displayed entries describe committed changes, not attempted or failed sign-ins.

There is no ordinary retention deletion endpoint. Both databases and this table must be included in encrypted operational backups. Customer data-export permissions remain separate from administrator access to activity. Retention policy, independently retained security archives, invitation lifecycle auditing, platform administration auditing, MFA/enterprise SSO, and dedicated failure/abuse event capture require further implementation and operational decisions. This feature does not assert regulatory compliance.

Verification covers transaction rollback on audit failure, immutable receipts, redaction, session/key mutations, concurrent vendor changes, tenant filtering, deterministic pagination, and the responsive activity view's loading, empty, failure and retry states.
