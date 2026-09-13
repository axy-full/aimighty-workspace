# Subscribed production-house workspaces

September 14, 2026. This adds the account, workspace and credit foundations for a self-service SaaS. Commercial launch remains gated on the payment implementation and operational checks below. Keep the existing Studio ($49/month, 400 credits), Agency ($199/month, 1,600 credits), and Production ($999/month, 9,000 credits) plans and credit packs. Annual billing remains 20% lower with monthly included-credit windows. Paid plans have unlimited members.

## Customer journey

1. Compare the configured plans at `/pricing`; carry the selected plan and cadence through signup.
2. Verify email before creating a customer workspace database. Approved platform invitations retain their existing one-time welcome grant. Direct registration and additional workspaces start with zero credits; selecting a plan never creates credits or paid entitlements.
3. Create or resume the studio's isolated workspace. Failed provisioning retains its account, request and resource identity for retry.
4. Subscribe from `/billing`, then receive entitlements and credits only from a verified payment event. **Stripe connection and provider fulfillment remain an outstanding release dependency; do not enable checkout until sandbox tests pass.**
5. Invite the team, start a production or explore the sample, upload a reference, confirm the quoted credit cost, generate, review and export.
6. Manage billing, usage, team access and workspace identity from the workbench workspace menu. Navigation waits for draft saves before switching tenant or signing out.

## Credit lifecycle

The platform ledger adds credit lots, source allocations, invoice-funded periods and credit windows. Migration preserves existing balances, including previously purchased credits without retroactive expiry. New paid monthly windows expire at their end. An annual paid period materializes monthly windows, rather than granting a year of spendable credits at once.

Included credits are drawn first. Paid packs and their bonuses measure their 12-month lifetime in time spent off a confirmed paid plan. On leaving a plan the remaining time resumes, consistent with the existing rule that the lifetime is time spent off-plan. Admin plan labels alone do not pause expiry or grant monthly credits.

Customer renders use the authored prompt and deterministic camera composition. Paid prompt writing is an explicit Atomik action; automatic refinement cannot add an unquoted charge. Writer connection checks perform no generation.

Reservations, concurrent balance checks and debit allocations commit together. Completion corrects the same debit. Releasing an expired included-credit reservation does not make those credits spendable again. Refund adjustments retain the historical source and record debt when refunded credits were already consumed. Manual top-up approval and both credit grants now commit atomically.

## Customer data and deletion

Tenant content remains in a separate database per workspace; platform billing/account tables filter by workspace identifier. Bearer callers require an active platform account and membership. Read tokens cannot mutate, and account/team/key/owner operations require browser sessions. Team invitation consumption and seat enforcement share a transaction.

The JSON export includes shared productions, shots, assets, published bibles, and the requesting owner's private workbench drafts and mappings. Other collaborators' private drafts, authentication records and credentials remain excluded. Media bytes have a separate authorized master manifest.

Deletion revokes access first. Cleanup waits ten minutes for running functions, then removes files, revokes any minted gateway key and drops the tenant database. Stage acknowledgments are durable; failed cleanup retains the credentials and identifiers needed for retry. Cron retries unfinished cleanup. A workspace is marked purged only after every stage succeeds.

## Configuration and release gates

`GET /api/admin/readiness` is restricted to the platform administrator and reports names/booleans without secret values. `.env.example` lists the supported configuration. Production and preview must have separate databases, storage and provider credentials. Never reuse the production database for preview verification.

Verified production configuration before this work had a working primary Turso database, Blob, Resend, Inngest and media-provider keys. It lacked Turso organization provisioning credentials, Stripe credentials and a canonical `APP_ORIGIN`. The canonical production `APP_ORIGIN=https://www.particl.app` is now set for the next deployment. The existing preview environment lacked a database URL and private Blob token.

Remaining external setup:

- Accept Stripe's Vercel Marketplace terms; provision its sandbox in preview/development. Activate the business account and configure live keys only after checkout, renewal, payment failure, cancellation and webhook replay tests pass.
- Implement hosted checkout, customer portal and signed webhook fulfillment after connecting Stripe. Verify invoice replay/order, monthly and annual renewal, refunds, 60-day inactivity cancellation, and subscription cancellation before a workspace can be purged. The ledger is implemented; the provider lifecycle is not.
- Sign in to the Turso organization. Create narrowly managed provisioning credentials and a separate staging group/database; configure `TURSO_API_TOKEN`, `TURSO_ORG` and the environment-specific group.
- Confirm Resend's configured sender can deliver verification and recovery emails. Tests use a local mail sink; development must not email real customers.
- Verify restore from the isolated staging database and private storage before claiming a recovery objective. Retain the keyring secret with the database backup.

Production `/api/health` reports missing storage or unreachable database as HTTP 503. Deep storage probes require authentication and the explicit `deep=1` parameter.

## Verification

Use Node 24. Local generation must run with `ENGINE_MOCK=1`; no paid generation, identity training or upscale is authorized for tests.

```
npm ci
npm run lint
npm run test:unit
node scripts/account-http-rehearsal.mjs
npm run build
ENGINE_MOCK=1 npm run dev -- -p 4551
PW_BASE_URL=http://localhost:4551 npx playwright test --config=playwright.workbench.config.ts
PW_BASE_URL=http://localhost:4551 npx playwright test --config=playwright.customer.config.ts
```

Use `PW_CHANNEL=chrome` on a machine with system Chrome or install Playwright Chromium. CI installs Chromium and runs the unit, production-build and browser checks on pull requests. The suites use isolated fixture databases and distinct output directories.

If using the database paths from `.env.example`, set `PW_PLATFORM_DATABASE_URL=file:.data/platform-dev.db` for the workbench suite so its local fixture targets the same platform database as the development server. This override accepts only `file:` databases.

The launch evidence must distinguish mocked-provider checks from real Stripe sandbox events and production configuration checks. A working public UI alone is not proof that studios can subscribe.

## Higgsfield benchmark

Higgsfield's published business offering establishes the comparison for self-service team workspaces, shared credits, invitations, assets and member usage: https://higgsfield.ai/creator-hub/help-center/business/team-and-business-higgsfield . Particl preserves its existing workspace pricing rather than adopting per-seat billing.

Its credit guide documents a visible balance, pre-generation cost and usage history: https://higgsfield.ai/creator-hub/help-center/credits/how-credits-work . Those are acceptance criteria across all Particl generation tools, including the older audio and identity routes.

Cinema Studio also documents reusable Elements, shot-level camera/lens controls and project style: https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-cinema-studio . This release does not establish full creative-feature parity. Particl's remaining creative limits include metadata-only visual reference understanding in Atomik and EDL/source delivery rather than a finished encoded movie. They must remain visible until implemented and verified.
