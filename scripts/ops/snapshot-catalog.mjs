#!/usr/bin/env node
/**
 * One-off: freeze the gateway's public model list into lib/modelCatalog.json.
 *
 * Reads GET https://ai-gateway.vercel.sh/v1/models (public metadata: no key,
 * no cost), keeps only the ids Particl offers (lib/catalogOffered.ts) and maps
 * each with the same function the live read uses (toCatalogModel in
 * lib/catalog.ts), so prices, limits, modalities and reasoning options are
 * exactly what is billed today. Nothing here runs at request time.
 *
 *   node scripts/ops/snapshot-catalog.mjs            # write lib/modelCatalog.json
 *   node scripts/ops/snapshot-catalog.mjs --check    # print what would change; write nothing
 *   node scripts/ops/snapshot-catalog.mjs --from=<saved /v1/models JSON> --priced-at=YYYY-MM-DD
 *
 * It writes nothing, and exits non-zero, when an offered id is missing from
 * the list or a model a feature can pick has no input or output price.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const SOURCE = "https://ai-gateway.vercel.sh/v1/models";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "lib/modelCatalog.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const from = args.find((a) => a.startsWith("--from="))?.slice("--from=".length);
const pricedAtArg = args.find((a) => a.startsWith("--priced-at="))?.slice("--priced-at=".length);
const fail = (message) => { console.error(`snapshot-catalog: ${message}`); process.exit(1); };
if (from && !pricedAtArg) fail("--from needs --priced-at=YYYY-MM-DD, the day that response was fetched");
const realDate = (d) => {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};
if (pricedAtArg !== undefined && !realDate(pricedAtArg))
  fail(`--priced-at must be a real YYYY-MM-DD date, got ${pricedAtArg}`);
if (pricedAtArg && !from) fail("--priced-at only goes with --from; a live read is priced today");

const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { buildCatalogSnapshot } = await jiti.import(path.join(root, "lib/catalog.ts"));
const { OFFERED_CATALOG_IDS, PRICED_TEXT_IDS } = await jiti.import(path.join(root, "lib/catalogOffered.ts"));

let body;
if (from) body = JSON.parse(await readFile(path.resolve(from), "utf8"));
else {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`);
  body = await res.json();
}
if (!Array.isArray(body?.data) || !body.data.length) throw new Error("the model list is empty");

const pricedAt = pricedAtArg ?? new Date().toISOString().slice(0, 10);
const snapshot = buildCatalogSnapshot(body.data, OFFERED_CATALOG_IDS, pricedAt, SOURCE);
const text = `${JSON.stringify(snapshot, null, 2)}\n`;

const perProvider = {};
for (const m of snapshot.models) perProvider[m.providerId] = (perProvider[m.providerId] ?? 0) + 1;
const unpriced = PRICED_TEXT_IDS.filter((id) => {
  const m = snapshot.models.find((x) => x.id === id);
  return !m || m.pricing?.input == null || m.pricing?.output == null;
});
console.log(JSON.stringify({ pricedAt, models: snapshot.models.length, perProvider, missing: snapshot.missing, unpricedRequired: unpriced }, null, 2));
// Never a partial snapshot: an offered id without an entry, or a pickable
// model without both prices, stops here before anything is written.
if (snapshot.missing.length || unpriced.length)
  fail(`refusing to write: ${snapshot.missing.length} missing, ${unpriced.length} unpriced (listed above)`);

if (check) {
  const before = await readFile(out, "utf8").catch(() => "");
  const old = before ? JSON.parse(before) : { models: [] };
  const key = (m) => JSON.stringify({ ...m, pricedAt: undefined });
  const oldById = new Map(old.models.map((m) => [m.id, key(m)]));
  const changed = snapshot.models.filter((m) => oldById.get(m.id) !== key(m)).map((m) => m.id);
  const gone = old.models.map((m) => m.id).filter((id) => !snapshot.models.some((m) => m.id === id));
  console.log(JSON.stringify({ changed, gone }, null, 2));
} else {
  await writeFile(out, text);
  console.log(`wrote ${path.relative(root, out)}`);
}
