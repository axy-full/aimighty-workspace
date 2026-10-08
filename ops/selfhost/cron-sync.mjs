// Runs inside the app container: calls the heartbeat route with the bearer secret
// the route checks (Authorization: Bearer <CRON_SECRET>). The secret is read from the
// container's own environment and never printed. Exit 0 on a 2xx answer.
const secret = process.env.CRON_SECRET;
if (!secret) { console.error("cron-sync: CRON_SECRET is not set in this container"); process.exit(2); }
const url = `http://127.0.0.1:${process.env.PORT || 3000}/api/cron/sync`;
try {
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(290_000) });
  console.log(`cron-sync: ${res.status}`);
  process.exit(res.ok ? 0 : 1);
} catch (e) {
  console.error(`cron-sync: failed (${e instanceof Error ? e.name : "error"})`);
  process.exit(1);
}
