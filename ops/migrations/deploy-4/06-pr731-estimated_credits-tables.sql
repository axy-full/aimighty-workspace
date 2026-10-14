-- Deploy #4 migration 6 of 6: PR #731 (feat/step0-estimated-credits), the two TABLES only. Database: every TENANT database and the house workspace's database
-- (the one-time fill reads the platform database's meter_events but writes only the tenant database). Exactly the statements the app runs (lib/db.ts SCHEMA). Idempotent; additive.
--
-- THE FILL IS NOT HERE, ON PURPOSE. The one-time fill of estimated_credits (one INSERT ... SELECT over generations, then the marker row) runs INSIDE THE APP, once per workspace,
-- on its first read of a take's credits (lib/estimatedCredits.ts). It is built from the private margin table (CREDIT_MARGINS and the defaults), which is not kept in this
-- repository, so it must not be copied into a file and cannot be run by hand from here. Applying this file creates the two EMPTY tables only; a copy tested with this file alone
-- therefore shows both tables, with zero rows, and the fill is exercised by the app's own tests (tests/unit/estimatedCredits.spec.ts).
CREATE TABLE IF NOT EXISTS estimated_credits (gen_id TEXT PRIMARY KEY, credits INTEGER NOT NULL, frozen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS estimated_credits_fill (id INTEGER PRIMARY KEY CHECK(id=1), filled_at INTEGER NOT NULL, first_meter_at INTEGER);
