import { createHash } from "node:crypto";
import { after } from "next/server";
import { platformDb, platformReady, now } from "./platform";
import { higgsfieldConfigured, higgsfieldCredentials } from "./higgsfield";
import { marketingJson } from "./higgsfieldMarketing";
import { engineMock } from "./mock";
import { withRecoveryActivity } from "./recovery";

/**
 * Some Higgsfield models are priced from their published pricing text rather
 * than a figure: for token-metered models the estimate endpoint returns the
 * text, not a price. This watch checks now and then that the text is still the
 * one the code prices from.
 *
 * It reads only the free, non-generating `POST /estimate/<path>`, only from a
 * production deployment, at most once per interval per model across the
 * platform. A change goes to the platform log and the watch table, for
 * platform admins only. It never changes a price, and it never blocks or
 * slows a quote.
 */
export type PricingWatch = {
  model: string;
  /** The provider's route, as used for `POST /estimate/<path>`. */
  path: string;
  /** A representative request the published pricing covers. */
  body: Record<string, unknown>;
  /** SHA-256 of the whitespace-normalized pricing text the code prices from. */
  expectedSha256: string;
  /** Particl's own figure for `body`, logged beside the provider's once it returns one. */
  formulaUsd?: () => number | null;
};
export type PricingWatchResult =
  | "skipped" | "busy" | "unchanged" | "changed" | "priced" | "unavailable";

const INTERVAL_MS = 6 * 60 * 60_000;
const RETRY_MS = 60 * 60_000;
const LEASE_MS = 10 * 60_000;
export const pricingDescriptionSha256 = (text: string) =>
  createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");

let table: Promise<void> | undefined;
async function watchReady(): Promise<void> {
  await platformReady();
  table ??= platformDb()
    .execute(`CREATE TABLE IF NOT EXISTS higgsfield_pricing_watch(model TEXT PRIMARY KEY, next_at INTEGER NOT NULL,
      status TEXT, observed_sha256 TEXT, detail TEXT, checked_at INTEGER)`)
    .then(() => undefined)
    .catch((error) => {
      table = undefined;
      throw error;
    });
  await table;
}

export async function checkHiggsfieldPricing(
  watch: PricingWatch,
  deps: { fetch?: typeof fetch; force?: boolean } = {},
): Promise<PricingWatchResult> {
  const live = deps.force === true || (process.env.NODE_ENV === "production" && !engineMock());
  if (!live || !higgsfieldConfigured()) return "skipped";
  await watchReady();
  const at = now();
  // One claim per interval, platform-wide. An interrupted check retries after its lease.
  const claimed = await platformDb().execute({
    sql: `INSERT INTO higgsfield_pricing_watch(model,next_at) VALUES(?,?)
      ON CONFLICT(model) DO UPDATE SET next_at=excluded.next_at WHERE higgsfield_pricing_watch.next_at<=? RETURNING model`,
    args: [watch.model, at + LEASE_MS, at],
  });
  if (!claimed.rows.length) return "busy";
  let result: PricingWatchResult = "unavailable";
  let observed: string | null = null;
  let detail: string | null = null;
  try {
    const reply = await withRecoveryActivity("external-read", async () => {
      const { keyId, keySecret } = higgsfieldCredentials();
      const response = await (deps.fetch ?? fetch)(`https://api.higgsfield.ai/estimate/${watch.path}`, {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Key ${keyId}:${keySecret}`, "Content-Type": "application/json" },
        body: JSON.stringify(watch.body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("estimate unavailable");
      }
      return marketingJson(response);
    });
    const usd = typeof reply.usd === "string" && /^\d+(?:\.\d+)?$/.test(reply.usd) ? Number(reply.usd)
      : typeof reply.usd === "number" ? reply.usd : NaN;
    if (typeof reply.pricing_description === "string") {
      observed = pricingDescriptionSha256(reply.pricing_description);
      result = observed === watch.expectedSha256 ? "unchanged" : "changed";
      if (result === "changed") detail = reply.pricing_description.slice(0, 2000);
    } else if (Number.isFinite(usd) && usd > 0) {
      // The provider now prices this request itself: set its figure beside ours.
      result = "priced";
      detail = JSON.stringify({ usd, formulaUsd: watch.formulaUsd?.() ?? null });
    }
  } catch {
    result = "unavailable";
  }
  await platformDb().execute({
    sql: "UPDATE higgsfield_pricing_watch SET next_at=?,status=?,observed_sha256=?,detail=?,checked_at=? WHERE model=?",
    args: [now() + (result === "unavailable" ? RETRY_MS : INTERVAL_MS), result, observed, detail, now(), watch.model],
  });
  if (result === "changed" || result === "priced")
    console.warn(JSON.stringify({ level: "warn", event: "higgsfield.pricing_watch", model: watch.model, result, observedSha256: observed }));
  return result;
}

/** Best effort, after the response when a request is in scope; a quote never waits for it. */
export function scheduleHiggsfieldPricingCheck(watch: PricingWatch): void {
  const task = () => checkHiggsfieldPricing(watch).then(() => undefined, () => undefined);
  try {
    after(task);
  } catch {
    void task();
  }
}
