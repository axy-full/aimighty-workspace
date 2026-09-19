/**
 * Read-only explainer style listing for the Generate page (slice F6): one
 * free `get_explainer_presets` read per connection per hour (memory cache),
 * plus whether the connected catalogue lists any explainer job to price.
 * Nothing here imports media, generates or spends.
 */
import { createHash } from "node:crypto";
import { requireTenant } from "@/lib/tenant";
import { ConsumerOAuthError, getConsumerAccess } from "./oauth";
import { readExplainerPresets } from "./mcp";
import { explainerModelsListed, type ExplainerPresets } from "./explainer-presets";
import { connectedGenerationCatalogue } from "./generation-service";

const TTL_MS = 3_600_000;
const cache = new Map<string, ExplainerPresets>();
export async function connectedExplainerPresets(userId: string, options: { refresh?: boolean } = {}) {
  const access = await getConsumerAccess(requireTenant().id, userId, {});
  if (!access) throw new ConsumerOAuthError("reconnect_required");
  const key = createHash("sha256").update(`${requireTenant().id}:${userId}:${access.generation}:explainer`).digest("hex").slice(0, 48);
  const now = Date.now(), cached = cache.get(key);
  const presets = !options.refresh && cached && cached.fetchedAt > now - TTL_MS && cached.fetchedAt <= now ? cached : await readExplainerPresets(access.accessToken);
  cache.set(key, presets);
  // The catalogue read is cached for an hour too; it decides runnability.
  const listed = explainerModelsListed(await connectedGenerationCatalogue(userId));
  return { ...presets, runnable: false as const, catalogueModels: listed };
}
export function forgetExplainerPresets() {
  cache.clear();
}
