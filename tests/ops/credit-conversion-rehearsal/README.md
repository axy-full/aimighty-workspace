Local rehearsal of the US$0.80 → US$0.10 credit conversion (PR #524). Fixture data only; local databases under `.data/conv-rehearsal/`; ENGINE_MOCK; port 4620. Never point it at a deployed URL or database.

1. `mkdir -p .data/conv-rehearsal && PHASE=seed CREDIT_USD=0.80 ENGINE_MOCK=1 PLATFORM_DATABASE_URL=file:$PWD/.data/conv-rehearsal/platform.db TURSO_DATABASE_URL=file:$PWD/.data/conv-rehearsal/legacy.db npx playwright test --config=tests/ops/credit-conversion-rehearsal/pw.config.ts a-seed`
2. `tests/ops/credit-conversion-rehearsal/serve.sh dev-080 0.80`, then `PHASE=at080` against `b-server` (PW_BASE_URL=http://localhost:4620, PW_PLATFORM_DATABASE_URL as above). Stop the server by its PID (`.data/conv-rehearsal/server.pid`, a process group).
3. `serve.sh dev-010` (CREDIT_USD unset), then `PHASE=at010a`, then `PHASE=settle` against `a-seed` (no server needed), then `PHASE=at010b`.

Evidence lands in `.data/evidence/`.
