#!/usr/bin/env node
/**
 * One-off: freeze the gateway's public model list into lib/modelCatalog.json.
 *
 * Reads GET https://ai-gateway.vercel.sh/v1/models (public metadata: no key,
 * no cost), keeps only the ids Particl offers, and the dropped ids old ledger rows name (lib/catalogOffered.ts SNAPSHOT_CATALOG_IDS), and maps
 * each with the same function the live read uses (toCatalogModel in
 * lib/catalog.ts), so prices, limits, modalities and reasoning options are
 * exactly what is billed today. Nothing here runs at request time.
 *
 *   node scripts/ops/snapshot-catalog.mjs            # write lib/modelCatalog.json
 *   node scripts/ops/snapshot-catalog.mjs --check    # print what would change; write nothing
 *   node scripts/ops/snapshot-catalog.mjs --from=<saved /v1/models JSON> --priced-at=YYYY-MM-DD
 *   node scripts/ops/snapshot-catalog.mjs --save=<file>   # also keep the raw response read (a live read only)
 *   node scripts/ops/snapshot-catalog.mjs --add=<id>      # repeatable: keep a language model no source file names
 *   node scripts/ops/snapshot-catalog.mjs --add=<id> --only-add   # add it and leave every other entry exactly as it is
 *   node scripts/ops/snapshot-catalog.mjs --out=<file>    # read and write that snapshot file instead (tests)
 *
 * An added id is recorded in the snapshot's `added` list and every later run
 * keeps it, as the provider-priced entries are kept; the runtime reads it from
 * there (lib/catalogOffered.ts), so no source file names it.
 *
 * It writes nothing, and exits non-zero, when an offered or added id is
 * missing from the list, a model a feature can pick has no input or output
 * price, or an added id is not a language model priced for a direct quote.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const SOURCE = "https://ai-gateway.vercel.sh/v1/models";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
// --out=<file>: read and write another snapshot file (the script's own tests); lib/modelCatalog.json otherwise.
const outArg = args.find((a) => a.startsWith("--out="))?.slice("--out=".length);
const out = outArg ? path.resolve(outArg) : path.join(root, "lib/modelCatalog.json");
const check = args.includes("--check");
const from = args.find((a) => a.startsWith("--from="))?.slice("--from=".length);
const pricedAtArg = args.find((a) => a.startsWith("--priced-at="))?.slice("--priced-at=".length);
const save = args.find((a) => a.startsWith("--save="))?.slice("--save=".length);
const addArgs = args.filter((a) => a.startsWith("--add=")).map((a) => a.slice("--add=".length).trim());
const onlyAdd = args.includes("--only-add");
const fail = (message) => { console.error(`snapshot-catalog: ${message}`); process.exit(1); };
if (save && from) fail("--save keeps a live read; --from already names a saved one");
if (addArgs.some((id) => !/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]{0,99}$/.test(id))) fail(`--add takes a catalogue id ("<owner>/<model>"), got ${addArgs.join(", ")}`);
if (from && !pricedAtArg) fail("--from needs --priced-at=YYYY-MM-DD, the day that response was fetched");
const realDate = (d) => {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};
if (pricedAtArg !== undefined && !realDate(pricedAtArg))
  fail(`--priced-at must be a real YYYY-MM-DD date, got ${pricedAtArg}`);
if (pricedAtArg && !from) fail("--priced-at only goes with --from; a live read is priced today");

const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { buildCatalogSnapshot, textQuoteCostUsd } = await jiti.import(path.join(root, "lib/catalog.ts"));
const { SNAPSHOT_CATALOG_IDS, PRICED_TEXT_IDS } = await jiti.import(path.join(root, "lib/catalogOffered.ts"));

let body;
if (from) body = JSON.parse(await readFile(path.resolve(from), "utf8"));
else {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!res.ok) throw new Error(`${SOURCE}: ${res.status}`);
  const raw = await res.text();
  if (save) await writeFile(path.resolve(save), raw);
  body = JSON.parse(raw);
}
if (!Array.isArray(body?.data) || !body.data.length) throw new Error("the model list is empty");

const pricedAt = pricedAtArg ?? new Date().toISOString().slice(0, 10);
const existing = JSON.parse(await readFile(out, "utf8").catch(() => "{}"));
// Provider-priced entries (models the gateway does not list, priced from each provider's own page) are carried over untouched.
const providerPriced = existing.providerPriced ?? [];
const handPriced = new Set(providerPriced.map((m) => m.id));
// Added ids (--add, now or on an earlier run) are carried over the same way: every refresh keeps them.
const added = [...new Set([...(existing.added ?? []), ...addArgs])];
const addedHandPriced = added.filter((id) => handPriced.has(id));
if (addedHandPriced.length) fail(`an added id is already provider-priced: ${addedHandPriced.join(", ")}`);
const wanted = [...new Set([...SNAPSHOT_CATALOG_IDS, ...added])].filter((id) => !handPriced.has(id));
const refreshed = buildCatalogSnapshot(body.data, wanted, pricedAt, SOURCE);

// --only-add: the existing snapshot stays exactly as it was; only the added ids it lacks are appended, priced on `pricedAt`.
let snapshot = refreshed;
if (onlyAdd) {
  if (!Array.isArray(existing.models)) fail("--only-add needs an existing lib/modelCatalog.json");
  const have = new Set(existing.models.map((m) => m.id));
  const fresh = refreshed.models.filter((m) => added.includes(m.id) && !have.has(m.id));
  snapshot = { ...existing, models: [...existing.models, ...fresh], missing: existing.missing ?? [] };
  delete snapshot.providerPriced; delete snapshot.added;
}
// What stops the write: every wanted id the list lacks on a refresh; an added id the list lacks with --only-add (the rest is not re-read).
const missing = onlyAdd ? added.filter((id) => !snapshot.models.some((m) => m.id === id)) : snapshot.missing;
const text = `${JSON.stringify({ ...snapshot, ...(providerPriced.length ? { providerPriced } : {}), ...(added.length ? { added } : {}) }, null, 2)}\n`;

const perProvider = {};
for (const m of snapshot.models) perProvider[m.providerId] = (perProvider[m.providerId] ?? 0) + 1;
const unpriced = PRICED_TEXT_IDS.filter((id) => {
  const m = snapshot.models.find((x) => x.id === id) ?? providerPriced.find((x) => x.id === id);
  return !m || m.pricing?.input == null || m.pricing?.output == null;
});
// An added id is a language model with input and output prices, and every price a direct quote needs (lib/catalog.ts textQuoteCostUsd).
const unfitAdded = added.filter((id) => {
  const m = snapshot.models.find((x) => x.id === id);
  return m && (m.type !== "language" || m.pricing?.input == null || m.pricing?.output == null || textQuoteCostUsd(m, 1_000, 100, true) == null);
});
console.log(JSON.stringify({ pricedAt, models: snapshot.models.length, perProvider, missing, unpricedRequired: unpriced, added, unfitAdded }, null, 2));
// Never a partial snapshot: an offered or added id without an entry, a pickable
// model without both prices, or an added id that cannot be quoted, stops here before anything is written.
if (missing.length || unpriced.length || unfitAdded.length)
  fail(`refusing to write: ${missing.length} missing, ${unpriced.length} unpriced, ${unfitAdded.length} added but unfit (listed above)`);

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
